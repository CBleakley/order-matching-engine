#pragma once

#include <cstdint>
#include <unordered_map>

#include "Clock.h"
#include "Events.h"
#include "InternalProtocol.h"
#include "OrderBook.h"
#include "Types.h"

// The engine service's core, with no sockets: it takes decoded gateway
// commands, runs them through the Phase 0 OrderBook, and emits the resulting
// protocol events through an EventOutput.
//
// Everything runs on one thread, so the book is never accessed concurrently.

namespace engine_service {

// Receives the live events the core emits.
class EventOutput {
public:
    virtual ~EventOutput() = default;
    virtual void send(const protocol::EngineMessage& message) = 0;
};

class EngineCore {
public:
    explicit EngineCore(Clock& clock) : clock_(clock), adapter_(*this), book_(adapter_) {}

    EngineCore(const EngineCore&)            = delete;
    EngineCore& operator=(const EngineCore&) = delete;

    // Where live events go. nullptr (no gateway attached) drops them; eventSeq
    // keeps counting either way, since it spans the process lifetime.
    void         setOutput(EventOutput* output) noexcept { output_ = output; }
    EventOutput* output() const noexcept { return output_; }

    // Assigns the next order ID and submits the order. Emits OrderAccepted,
    // then Trade per fill and OrderRested for any remainder; or OrderRejected
    // (orderId 0) without consuming an ID.
    void submit(const protocol::SubmitOrder& command) {
        current_ = {.clientTag = command.clientTag,
                    .traderId  = command.traderId,
                    .side      = command.side,
                    .price     = command.price,
                    .qty       = command.qty,
                    .isSubmit  = true,
                    .accepted  = false,
                    .ts        = clock_.now()};
        book_.submit(nextOrderId_, command.traderId, command.side, command.price, command.qty);
        if (current_.accepted) ++nextOrderId_;
    }

    // Cancels a resting order. Emits OrderCancelled, or OrderRejected
    // (UnknownOrderId) if the order is not resting.
    void cancel(const protocol::CancelOrder& command) {
        current_ = {.clientTag = command.clientTag,
                    .traderId  = command.traderId,
                    .side      = engine::Side::Buy,
                    .price     = 0,
                    .qty       = 0,
                    .isSubmit  = false,
                    .accepted  = false,
                    .ts        = clock_.now()};
        book_.cancel(command.orderId);
    }

    const engine::OrderBook& book() const noexcept { return book_; }
    engine::OrderId          nextOrderId() const noexcept { return nextOrderId_; }
    protocol::EventSeq       nextEventSeq() const noexcept { return nextEventSeq_; }

private:
    // The command being processed, for filling in event fields the book's
    // events do not carry.
    struct Command {
        protocol::ClientTag clientTag;
        engine::TraderId    traderId;
        engine::Side        side;
        engine::Price       price;
        engine::Quantity    qty;
        bool                isSubmit;
        bool                accepted;
        protocol::Timestamp ts;  // read once, so one command's events share it
    };

    struct Resting {
        engine::TraderId traderId;
        engine::Quantity remaining;
    };

    // Turns OrderBook events into protocol messages.
    class Adapter final : public engine::EventSink {
    public:
        explicit Adapter(EngineCore& core) : core_(core) {}

        void onAccepted(const engine::OrderAccepted& e) override {
            Command& c = core_.current_;
            c.accepted = true;
            core_.emit(protocol::OrderAccepted{.eventSeq = core_.nextEventSeq_++,
                                               .ts       = c.ts,
                                               .clientTag = c.clientTag,
                                               .orderId  = e.id,
                                               .traderId = c.traderId,
                                               .side     = c.side,
                                               .price    = c.price,
                                               .qty      = c.qty});
        }

        void onRejected(const engine::OrderRejected& e) override {
            const Command& c = core_.current_;
            core_.emit(protocol::OrderRejected{.eventSeq  = core_.nextEventSeq_++,
                                               .ts        = c.ts,
                                               .clientTag = c.clientTag,
                                               .orderId   = c.isSubmit ? 0 : e.id,
                                               .traderId  = c.traderId,
                                               .reason    = protocol::toRejectCode(e.reason)});
        }

        void onTrade(const engine::TradeEvent& e) override {
            const auto maker = core_.resting_.find(e.makerId);
            if (maker != core_.resting_.end()) {
                maker->second.remaining -= e.qty;
                if (maker->second.remaining <= 0) core_.resting_.erase(maker);
            }
            core_.emit(protocol::Trade{.eventSeq       = core_.nextEventSeq_++,
                                       .ts             = core_.current_.ts,
                                       .makerOrderId   = e.makerId,
                                       .takerOrderId   = e.takerId,
                                       .buyerTraderId  = e.buyer,
                                       .sellerTraderId = e.seller,
                                       .price          = e.price,
                                       .qty            = e.qty,
                                       .aggressorSide  = e.aggressorSide});
        }

        void onRested(const engine::OrderRested& e) override {
            const Command& c = core_.current_;
            core_.resting_[e.id] = {c.traderId, e.qty};
            core_.emit(protocol::OrderRested{.eventSeq     = core_.nextEventSeq_++,
                                             .ts           = c.ts,
                                             .orderId      = e.id,
                                             .traderId     = c.traderId,
                                             .side         = e.side,
                                             .price        = e.price,
                                             .remainingQty = e.qty});
        }

        void onCancelled(const engine::OrderCancelled& e) override {
            // The owner, not the requester: P1-05 adds the check that they match.
            engine::TraderId owner = core_.current_.traderId;
            if (const auto it = core_.resting_.find(e.id); it != core_.resting_.end()) {
                owner = it->second.traderId;
                core_.resting_.erase(it);
            }
            core_.emit(protocol::OrderCancelled{.eventSeq     = core_.nextEventSeq_++,
                                                .ts           = core_.current_.ts,
                                                .orderId      = e.id,
                                                .traderId     = owner,
                                                .cancelledQty = e.cancelledQty});
        }

    private:
        EngineCore& core_;
    };

    void emit(const protocol::EngineMessage& message) {
        if (output_ != nullptr) output_->send(message);
    }

    Clock&            clock_;
    Adapter           adapter_;  // declared before book_, which holds a reference to it
    engine::OrderBook book_;
    EventOutput*      output_ = nullptr;

    Command                                       current_{};
    std::unordered_map<engine::OrderId, Resting> resting_;
    engine::OrderId                               nextOrderId_  = 1;
    protocol::EventSeq                            nextEventSeq_ = 1;
};

}  // namespace engine_service

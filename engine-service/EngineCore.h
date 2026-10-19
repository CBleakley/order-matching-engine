#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <limits>
#include <unordered_map>
#include <vector>

#include "Clock.h"
#include "Events.h"
#include "Instrument.h"
#include "InternalProtocol.h"
#include "OrderBook.h"
#include "Types.h"

// The engine service's core, with no sockets: it takes decoded gateway
// commands, runs them through the Phase 0 OrderBook, and emits the resulting
// protocol events through an EventOutput.
//
// The core is the authority on order identity and ownership: it assigns every
// order ID, validates orders against the instrument's limits, rejects cancels
// from anyone but the order's owner, and retains recent trades so that a
// (re)connecting gateway can rebuild its state from a snapshot.
//
// Everything runs on one thread, so the book is never accessed concurrently.

namespace engine_service {

// Receives the live events the core emits.
class EventOutput {
public:
    virtual ~EventOutput() = default;
    virtual void send(const protocol::EngineMessage& message) = 0;
};

struct CoreConfig {
    engine::Price            minPriceTicks;
    engine::Price            maxPriceTicks;
    engine::Quantity         maxOrderQty;
    std::chrono::nanoseconds tradeRetention = std::chrono::hours(24);

    static CoreConfig forInstrument(const InstrumentConfig& instrument,
                                    std::chrono::nanoseconds retention) {
        return {.minPriceTicks  = instrument.minPriceTicks,
                .maxPriceTicks  = instrument.maxPriceTicks,
                .maxOrderQty    = instrument.maxOrderQty,
                .tradeRetention = retention};
    }
};

class EngineCore {
public:
    EngineCore(Clock& clock, CoreConfig config)
        : clock_(clock), config_(config), adapter_(*this), book_(adapter_) {}

    EngineCore(const EngineCore&)            = delete;
    EngineCore& operator=(const EngineCore&) = delete;

    // Where live events go. nullptr (no gateway attached) drops them; eventSeq
    // keeps counting either way, since it spans the process lifetime.
    void         setOutput(EventOutput* output) noexcept { output_ = output; }
    EventOutput* output() const noexcept { return output_; }

    // A second receiver of every live event, sent before the gateway output.
    // The market simulator uses it to follow its own orders. It must not call
    // back into the core from send(). Snapshots are not sent to it.
    void setObserver(EventOutput* observer) noexcept { observer_ = observer; }

    // Checks the order against the instrument's limits, assigns the next
    // order ID and submits it. Emits OrderAccepted, then Trade per fill and
    // OrderRested for any remainder; or OrderRejected (orderId 0) without
    // consuming an ID.
    void submit(const protocol::SubmitOrder& command) {
        if (command.price < config_.minPriceTicks || command.price > config_.maxPriceTicks) {
            reject(command.clientTag, 0, command.traderId, protocol::RejectCode::PriceOutOfRange);
            return;
        }
        if (command.qty < 1 || command.qty > config_.maxOrderQty) {
            reject(command.clientTag, 0, command.traderId, protocol::RejectCode::QtyOutOfRange);
            return;
        }
        // The book validates again, as a second line of defence.
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

    // Cancels a resting order on behalf of its owner. Emits OrderCancelled;
    // or OrderRejected with NotOwner, without touching the book, if another
    // trader owns the order; or with UnknownOrderId if it is not resting.
    void cancel(const protocol::CancelOrder& command) {
        if (const auto it = resting_.find(command.orderId);
            it != resting_.end() && it->second.traderId != command.traderId) {
            reject(command.clientTag, command.orderId, command.traderId,
                   protocol::RejectCode::NotOwner);
            return;
        }
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

    // Sends the current state to `out`: SnapshotBegin, one RestingOrder per
    // resting order (bids then asks, each best price first and in time
    // priority within a level), one TradeReplay per retained trade (oldest
    // first), then SnapshotEnd. Both markers carry the eventSeq of the next
    // live event; the snapshot itself consumes none.
    void writeSnapshot(EventOutput& out) {
        evictExpiredTrades(clock_.now());
        out.send(protocol::SnapshotBegin{.eventSeq = nextEventSeq_});
        writeRestingOrders(engine::Side::Buy, out);
        writeRestingOrders(engine::Side::Sell, out);
        for (const protocol::Trade& t : trades_) {
            out.send(protocol::TradeReplay{.eventSeq       = t.eventSeq,
                                           .ts             = t.ts,
                                           .makerOrderId   = t.makerOrderId,
                                           .takerOrderId   = t.takerOrderId,
                                           .buyerTraderId  = t.buyerTraderId,
                                           .sellerTraderId = t.sellerTraderId,
                                           .price          = t.price,
                                           .qty            = t.qty,
                                           .aggressorSide  = t.aggressorSide});
        }
        out.send(protocol::SnapshotEnd{.eventSeq = nextEventSeq_});
    }

    const engine::OrderBook& book() const noexcept { return book_; }
    engine::OrderId          nextOrderId() const noexcept { return nextOrderId_; }
    protocol::EventSeq       nextEventSeq() const noexcept { return nextEventSeq_; }
    std::size_t              retainedTradeCount() const noexcept { return trades_.size(); }

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

    // What the core tracks about a resting order beyond what the book keeps.
    struct Resting {
        engine::TraderId    traderId;
        engine::Quantity    originalQty;
        engine::Quantity    remaining;
        protocol::Timestamp acceptedAt;
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
            const protocol::Trade trade{.eventSeq       = core_.nextEventSeq_++,
                                        .ts             = core_.current_.ts,
                                        .makerOrderId   = e.makerId,
                                        .takerOrderId   = e.takerId,
                                        .buyerTraderId  = e.buyer,
                                        .sellerTraderId = e.seller,
                                        .price          = e.price,
                                        .qty            = e.qty,
                                        .aggressorSide  = e.aggressorSide};
            core_.trades_.push_back(trade);
            core_.evictExpiredTrades(trade.ts);
            core_.emit(trade);
        }

        void onRested(const engine::OrderRested& e) override {
            const Command& c = core_.current_;
            core_.resting_[e.id] = {.traderId    = c.traderId,
                                    .originalQty = c.qty,
                                    .remaining   = e.qty,
                                    .acceptedAt  = c.ts};
            core_.emit(protocol::OrderRested{.eventSeq     = core_.nextEventSeq_++,
                                             .ts           = c.ts,
                                             .orderId      = e.id,
                                             .traderId     = c.traderId,
                                             .side         = e.side,
                                             .price        = e.price,
                                             .remainingQty = e.qty});
        }

        void onCancelled(const engine::OrderCancelled& e) override {
            // cancel() has already checked that the requester is the owner.
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
        if (observer_ != nullptr) observer_->send(message);
        if (output_ != nullptr) output_->send(message);
    }

    // A rejection decided by the service itself, before the book is involved.
    void reject(protocol::ClientTag clientTag, engine::OrderId orderId,
                engine::TraderId traderId, protocol::RejectCode reason) {
        emit(protocol::OrderRejected{.eventSeq  = nextEventSeq_++,
                                     .ts        = clock_.now(),
                                     .clientTag = clientTag,
                                     .orderId   = orderId,
                                     .traderId  = traderId,
                                     .reason    = reason});
    }

    // Drops trades more than the retention period older than `now`. A trade
    // exactly the retention period old is kept.
    void evictExpiredTrades(protocol::Timestamp now) {
        const protocol::Timestamp retention = config_.tradeRetention.count();
        while (!trades_.empty() && now - trades_.front().ts > retention) trades_.pop_front();
    }

    void writeRestingOrders(engine::Side side, EventOutput& out) {
        book_.depth(side, std::numeric_limits<std::size_t>::max(), levels_);
        for (const engine::OrderBook::LevelView& level : levels_) {
            book_.forEachOrder(side, level.price, [&](const engine::Order& order) {
                // Every resting order is tracked from its OrderRested event.
                const Resting& info = resting_.at(order.id);
                out.send(protocol::RestingOrder{.orderId      = order.id,
                                                .traderId     = order.trader,
                                                .side         = order.side,
                                                .price        = order.price,
                                                .originalQty  = info.originalQty,
                                                .remainingQty = order.remaining,
                                                .acceptedAt   = info.acceptedAt});
            });
        }
    }

    Clock&            clock_;
    CoreConfig        config_;
    Adapter           adapter_;  // declared before book_, which holds a reference to it
    engine::OrderBook book_;
    EventOutput*      output_   = nullptr;
    EventOutput*      observer_ = nullptr;

    Command                                      current_{};
    std::unordered_map<engine::OrderId, Resting> resting_;   // ownership of resting orders
    std::deque<protocol::Trade>                  trades_;    // retained trades, oldest first
    std::vector<engine::OrderBook::LevelView>    levels_;    // scratch for writeSnapshot
    engine::OrderId                              nextOrderId_  = 1;
    protocol::EventSeq                           nextEventSeq_ = 1;
};

}  // namespace engine_service

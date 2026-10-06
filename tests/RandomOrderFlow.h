#pragma once

#include <cstddef>
#include <cstdint>
#include <random>
#include <unordered_map>
#include <variant>
#include <vector>

#include "Events.h"
#include "Types.h"

// Seeded generator of random order flow: a stream of submits and cancels for
// driving an order book in differential tests, and later as the benchmark load
// generator. It has no test-framework or I/O dependencies.
//
// The generator is also an EventSink. Forward the book's events to it so it
// knows which orders are resting; most cancels then target live orders. Given
// the same seed, config and (deterministic) book, the stream is identical on
// every platform: only std::mt19937_64 is used, whose output is fully
// specified, and not the standard distributions, whose output is not.

namespace flow {

struct OrderFlowConfig {
    std::size_t      operations = 10'000;  // for callers; next() itself never stops
    engine::Price    midPrice    = 1000;
    engine::Price    priceSpread = 20;  // prices are uniform in midPrice +/- priceSpread
    engine::Quantity minQty      = 1;
    engine::Quantity maxQty      = 100;
    double           cancelProbability        = 0.3;
    std::uint32_t    traders                  = 10;
    double           invalidCancelProbability = 0.05;  // share of cancels with an unknown ID
    double           invalidSubmitProbability = 0.01;  // share of submits that are invalid
};

struct SubmitOp {
    engine::OrderId  id;
    engine::TraderId trader;
    engine::Side     side;
    engine::Price    price;
    engine::Quantity qty;
};

struct CancelOp {
    engine::OrderId id;
};

using Operation = std::variant<SubmitOp, CancelOp>;

class RandomOrderFlow : public engine::EventSink {
public:
    RandomOrderFlow(std::uint64_t seed, const OrderFlowConfig& config)
        : config_(config), rng_(seed) {}

    Operation next() {
        if (!resting_.empty() && chance(config_.cancelProbability)) return makeCancel();
        return makeSubmit();
    }

    // Apply an operation to any book with the OrderBook interface.
    template <typename Book>
    static void apply(Book& book, const Operation& op) {
        if (const auto* s = std::get_if<SubmitOp>(&op)) {
            book.submit(s->id, s->trader, s->side, s->price, s->qty);
        } else {
            book.cancel(std::get<CancelOp>(op).id);
        }
    }

    std::size_t restingCount() const noexcept { return resting_.size(); }

    // --- EventSink: track which orders are resting, and their quantity. ---

    void onRested(const engine::OrderRested& e) override { add(e.id, e.qty); }

    void onTrade(const engine::TradeEvent& e) override {
        const auto it = slots_.find(e.makerId);
        if (it == slots_.end()) return;
        it->second.remaining -= e.qty;
        if (it->second.remaining <= 0) remove(e.makerId);
    }

    void onCancelled(const engine::OrderCancelled& e) override { remove(e.id); }

private:
    Operation makeSubmit() {
        SubmitOp op{
            .id     = nextId_,
            .trader = static_cast<engine::TraderId>(uniform(0, config_.traders - 1)),
            .side   = chance(0.5) ? engine::Side::Buy : engine::Side::Sell,
            .price  = config_.midPrice + uniformSigned(-config_.priceSpread, config_.priceSpread),
            .qty    = uniformSigned(config_.minQty, config_.maxQty),
        };

        if (chance(config_.invalidSubmitProbability)) {
            switch (uniform(0, 2)) {
                case 0: op.qty = -uniformSigned(0, 5); break;    // zero or negative quantity
                case 1: op.price = -uniformSigned(0, 5); break;  // zero or negative price
                default:
                    // Reuse the ID of a resting order, if there is one.
                    if (!resting_.empty()) {
                        op.id = randomResting();
                        return op;  // the duplicate does not consume a fresh ID
                    }
                    op.qty = 0;
                    break;
            }
        }
        ++nextId_;
        return op;
    }

    Operation makeCancel() {
        if (!chance(config_.invalidCancelProbability)) return CancelOp{randomResting()};

        // An ID that has not been issued yet, or (usually) one that has already
        // left the book. The latter may occasionally pick a resting order.
        if (nextId_ == 1 || chance(0.5)) return CancelOp{nextId_ + 1 + uniform(0, 1000)};
        return CancelOp{uniform(1, nextId_ - 1)};
    }

    engine::OrderId randomResting() { return resting_[uniform(0, resting_.size() - 1)]; }

    void add(engine::OrderId id, engine::Quantity qty) {
        slots_[id] = Slot{resting_.size(), qty};
        resting_.push_back(id);
    }

    // Swap-remove from resting_, keeping slots_ indices in sync.
    void remove(engine::OrderId id) {
        const auto it = slots_.find(id);
        if (it == slots_.end()) return;
        const std::size_t index = it->second.index;
        const engine::OrderId last = resting_.back();
        resting_[index] = last;
        slots_[last].index = index;
        resting_.pop_back();
        slots_.erase(id);
    }

    // Uniform integer in [lo, hi]. The modulo bias is negligible for the small
    // ranges used here.
    std::uint64_t uniform(std::uint64_t lo, std::uint64_t hi) {
        return lo + rng_() % (hi - lo + 1);
    }

    std::int64_t uniformSigned(std::int64_t lo, std::int64_t hi) {
        return lo + static_cast<std::int64_t>(uniform(0, static_cast<std::uint64_t>(hi - lo)));
    }

    // True with probability p.
    bool chance(double p) {
        constexpr double kScale = 1.0 / 9007199254740992.0;  // 2^-53
        return static_cast<double>(rng_() >> 11) * kScale < p;
    }

    struct Slot {
        std::size_t      index;  // position in resting_
        engine::Quantity remaining;
    };

    OrderFlowConfig    config_;
    std::mt19937_64    rng_;
    engine::OrderId    nextId_ = 1;
    std::vector<engine::OrderId>                  resting_;
    std::unordered_map<engine::OrderId, Slot>     slots_;
};

}  // namespace flow

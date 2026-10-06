#pragma once

#include <algorithm>
#include <cstddef>
#include <optional>
#include <vector>

#include "Events.h"
#include "Types.h"

// A deliberately naive order book used as an oracle in differential tests.
//
// It has the same interface and emits the same events as engine::OrderBook,
// but every operation is a linear scan over a single vector of resting orders.
// It is written to be easy to check by reading, not to be fast, and shares no
// matching code with the real engine.

namespace engine {

class ReferenceOrderBook {
public:
    explicit ReferenceOrderBook(EventSink& sink) : sink_(sink) {}

    void submit(OrderId id, TraderId trader, Side side, Price price, Quantity qty) {
        if (price <= 0) {
            sink_.onRejected({id, RejectReason::InvalidPrice});
            return;
        }
        if (qty <= 0) {
            sink_.onRejected({id, RejectReason::InvalidQuantity});
            return;
        }
        if (findResting(id) != resting_.end()) {
            sink_.onRejected({id, RejectReason::DuplicateOrderId});
            return;
        }

        Order taker{id, trader, side, price, qty, nextSeq_++};
        sink_.onAccepted({taker.id, taker.seq});

        // Repeatedly trade with the best resting order that crosses.
        while (taker.remaining > 0) {
            const auto maker = findBestMatch(taker);
            if (maker == resting_.end()) break;

            const Quantity traded = std::min(taker.remaining, maker->remaining);
            taker.remaining -= traded;
            maker->remaining -= traded;

            TradeEvent trade{};
            trade.makerId       = maker->id;
            trade.takerId       = taker.id;
            trade.buyer         = taker.side == Side::Buy ? taker.trader : maker->trader;
            trade.seller        = taker.side == Side::Sell ? taker.trader : maker->trader;
            trade.price         = maker->price;  // trades execute at the resting price
            trade.qty           = traded;
            trade.aggressorSide = taker.side;
            trade.seq           = nextSeq_++;
            sink_.onTrade(trade);

            if (maker->remaining == 0) resting_.erase(maker);
        }

        if (taker.remaining > 0) {
            resting_.push_back(taker);
            sink_.onRested({taker.id, taker.side, taker.price, taker.remaining});
        }
    }

    void cancel(OrderId id) {
        const auto it = findResting(id);
        if (it == resting_.end()) {
            sink_.onRejected({id, RejectReason::UnknownOrderId});
            return;
        }
        const Quantity remaining = it->remaining;
        resting_.erase(it);
        sink_.onCancelled({id, remaining});
    }

    std::size_t orderCount() const { return resting_.size(); }

    std::optional<Price> bestBid() const { return bestPrice(Side::Buy); }
    std::optional<Price> bestAsk() const { return bestPrice(Side::Sell); }

private:
    std::vector<Order>::iterator findResting(OrderId id) {
        return std::find_if(resting_.begin(), resting_.end(),
                            [id](const Order& o) { return o.id == id; });
    }

    // True if a resting order at `restingPrice` would trade with `taker`.
    static bool crosses(const Order& taker, Price restingPrice) {
        return taker.side == Side::Buy ? restingPrice <= taker.price : restingPrice >= taker.price;
    }

    // True if resting order `a` should trade before resting order `b`: better
    // price first (lower for asks, higher for bids), then earlier arrival.
    static bool hasPriority(const Order& a, const Order& b) {
        if (a.price != b.price) {
            return a.side == Side::Sell ? a.price < b.price : a.price > b.price;
        }
        return a.seq < b.seq;
    }

    // The resting order the taker should trade with next, or end() if none.
    std::vector<Order>::iterator findBestMatch(const Order& taker) {
        auto best = resting_.end();
        for (auto it = resting_.begin(); it != resting_.end(); ++it) {
            if (it->side == taker.side) continue;
            if (!crosses(taker, it->price)) continue;
            if (best == resting_.end() || hasPriority(*it, *best)) best = it;
        }
        return best;
    }

    std::optional<Price> bestPrice(Side side) const {
        std::optional<Price> best;
        for (const Order& o : resting_) {
            if (o.side != side) continue;
            if (!best || (side == Side::Buy ? o.price > *best : o.price < *best)) best = o.price;
        }
        return best;
    }

    EventSink&         sink_;
    std::vector<Order> resting_;
    SeqNum             nextSeq_ = 1;
};

}  // namespace engine

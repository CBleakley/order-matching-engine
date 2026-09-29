#pragma once

#include <algorithm>
#include <deque>
#include <functional>
#include <map>
#include <unordered_set>

#include "Events.h"
#include "Types.h"

// Single-instrument limit order book with price-time priority. The book does
// no I/O: everything it does is reported to an EventSink.

namespace engine {

class OrderBook {
public:
    explicit OrderBook(EventSink& sink) : sink_(sink) {}

    OrderBook(const OrderBook&)            = delete;
    OrderBook& operator=(const OrderBook&) = delete;

    // Validates the order, matches it against the opposite side, and rests any
    // remainder. Emits OrderRejected on failure; otherwise OrderAccepted, then
    // a TradeEvent per fill, then OrderRested if quantity remains.
    void submit(OrderId id, TraderId trader, Side side, Price price, Quantity qty) {
        if (price <= 0) {
            sink_.onRejected({id, RejectReason::InvalidPrice});
            return;
        }
        if (qty <= 0) {
            sink_.onRejected({id, RejectReason::InvalidQuantity});
            return;
        }
        if (restingIds_.contains(id)) {
            sink_.onRejected({id, RejectReason::DuplicateOrderId});
            return;
        }

        Order order{id, trader, side, price, qty, nextSeq_++};
        sink_.onAccepted({order.id, order.seq});

        if (side == Side::Buy) {
            match(order, asks_);
            if (order.remaining > 0) rest(order, bids_);
        } else {
            match(order, bids_);
            if (order.remaining > 0) rest(order, asks_);
        }
    }

private:
    using Level = std::deque<Order>;
    // Both sides are ordered so the best price is at begin().
    using BuySide  = std::map<Price, Level, std::greater<Price>>;
    using SellSide = std::map<Price, Level, std::less<Price>>;

    static bool crosses(const Order& taker, Price restingPrice) noexcept {
        return taker.side == Side::Buy ? taker.price >= restingPrice : taker.price <= restingPrice;
    }

    // Fills the taker against the opposite side, best price first and FIFO
    // within a level, until it is filled or the prices no longer cross.
    template <typename OppositeSide>
    void match(Order& taker, OppositeSide& opposite) {
        while (taker.remaining > 0 && !opposite.empty()) {
            auto levelIt = opposite.begin();
            if (!crosses(taker, levelIt->first)) break;

            Level& level = levelIt->second;
            while (taker.remaining > 0 && !level.empty()) {
                Order& maker       = level.front();
                const Quantity qty = std::min(taker.remaining, maker.remaining);
                taker.remaining -= qty;
                maker.remaining -= qty;

                const bool takerIsBuy = taker.side == Side::Buy;
                sink_.onTrade({
                    .makerId       = maker.id,
                    .takerId       = taker.id,
                    .buyer         = takerIsBuy ? taker.trader : maker.trader,
                    .seller        = takerIsBuy ? maker.trader : taker.trader,
                    .price         = maker.price,
                    .qty           = qty,
                    .aggressorSide = taker.side,
                    .seq           = nextSeq_++,
                });

                if (maker.remaining == 0) {
                    restingIds_.erase(maker.id);
                    level.pop_front();
                }
            }

            if (level.empty()) opposite.erase(levelIt);
        }
    }

    template <typename SameSide>
    void rest(const Order& order, SameSide& side) {
        side[order.price].push_back(order);
        restingIds_.insert(order.id);
        sink_.onRested({order.id, order.side, order.price, order.remaining});
    }

    EventSink& sink_;
    BuySide    bids_;
    SellSide   asks_;
    // IDs of orders currently resting in the book, for duplicate detection.
    std::unordered_set<OrderId> restingIds_;
    SeqNum nextSeq_ = 1;
};

}  // namespace engine

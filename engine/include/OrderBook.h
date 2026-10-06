#pragma once

#include <algorithm>
#include <functional>
#include <iterator>
#include <list>
#include <map>
#include <unordered_map>

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
        if (index_.contains(id)) {
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

    // Removes a resting order from the book and emits OrderCancelled with its
    // remaining quantity. Emits OrderRejected (UnknownOrderId) if the order is
    // not resting: never seen, already filled, or already cancelled.
    void cancel(OrderId id) {
        const auto indexIt = index_.find(id);
        if (indexIt == index_.end()) {
            sink_.onRejected({id, RejectReason::UnknownOrderId});
            return;
        }

        const Location& loc      = indexIt->second;
        const Quantity remaining = loc.side == Side::Buy ? removeResting(bids_, loc)
                                                         : removeResting(asks_, loc);
        index_.erase(indexIt);
        sink_.onCancelled({id, remaining});
    }

private:
    friend struct OrderBookTestPeer;

    struct Level {
        std::list<Order> orders;
        Quantity totalQty = 0;  // sum of remaining qty of all orders at this level
    };
    // Both sides are ordered so the best price is at begin().
    using BuySide  = std::map<Price, Level, std::greater<Price>>;
    using SellSide = std::map<Price, Level, std::less<Price>>;

    // Where a resting order lives. std::list iterators stay valid while other
    // orders are inserted or erased, so these remain usable until the order
    // itself leaves the book.
    struct Location {
        Side                       side;
        Price                      price;
        std::list<Order>::iterator it;
    };

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
            while (taker.remaining > 0 && !level.orders.empty()) {
                Order& maker       = level.orders.front();
                const Quantity qty = std::min(taker.remaining, maker.remaining);
                taker.remaining -= qty;
                maker.remaining -= qty;
                level.totalQty -= qty;

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
                    index_.erase(maker.id);
                    level.orders.pop_front();
                }
            }

            if (level.orders.empty()) opposite.erase(levelIt);
        }
    }

    template <typename SameSide>
    void rest(const Order& order, SameSide& side) {
        Level& level = side[order.price];
        level.orders.push_back(order);
        level.totalQty += order.remaining;
        index_.emplace(order.id,
                       Location{order.side, order.price, std::prev(level.orders.end())});
        sink_.onRested({order.id, order.side, order.price, order.remaining});
    }

    // Erases the order at `loc` from its level, removing the level if it is
    // left empty, and returns the order's remaining quantity. Does not touch
    // the index.
    template <typename SameSide>
    static Quantity removeResting(SameSide& side, const Location& loc) {
        const auto levelIt = side.find(loc.price);
        Level& level       = levelIt->second;

        const Quantity remaining = loc.it->remaining;
        level.totalQty -= remaining;
        level.orders.erase(loc.it);
        if (level.orders.empty()) side.erase(levelIt);
        return remaining;
    }

    EventSink& sink_;
    BuySide    bids_;
    SellSide   asks_;
    // Every order currently resting in the book, for cancellation and
    // duplicate-ID detection.
    std::unordered_map<OrderId, Location> index_;
    SeqNum nextSeq_ = 1;
};

}  // namespace engine

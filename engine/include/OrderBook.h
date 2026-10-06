#pragma once

#include <algorithm>
#include <cstddef>
#include <functional>
#include <iterator>
#include <list>
#include <map>
#include <optional>
#include <unordered_map>
#include <vector>

#include "Events.h"
#include "Types.h"

// Single-instrument limit order book with price-time priority. The book does
// no I/O: everything it does is reported to an EventSink.

namespace engine {

struct InvariantChecker;

class OrderBook {
public:
    // Aggregate view of one price level, as returned by depth().
    struct LevelView {
        Price       price;
        Quantity    totalQty;
        std::size_t orderCount;

        bool operator==(const LevelView&) const = default;
    };

    explicit OrderBook(EventSink& sink) : sink_(sink) {}

    OrderBook(const OrderBook&)            = delete;
    OrderBook& operator=(const OrderBook&) = delete;

    // Validates the order, matches it against the opposite side, and rests any
    // remainder. Emits OrderRejected on failure; otherwise OrderAccepted, then
    // a TradeEvent per fill, then OrderRested if quantity remains.
    void submit(OrderId id, TraderId trader, Side side, Price price, Quantity qty) {
        submitImpl(id, trader, side, price, qty);
#ifdef ENGINE_CHECK_INVARIANTS
        verifyInvariants("submit");
#endif
    }

    // Removes a resting order from the book and emits OrderCancelled with its
    // remaining quantity. Emits OrderRejected (UnknownOrderId) if the order is
    // not resting: never seen, already filled, or already cancelled.
    void cancel(OrderId id) {
        cancelImpl(id);
#ifdef ENGINE_CHECK_INVARIANTS
        verifyInvariants("cancel");
#endif
    }

    // --- Queries. None of these modify the book or emit events. ---

    std::optional<Price> bestBid() const { return bestPrice(bids_); }
    std::optional<Price> bestAsk() const { return bestPrice(asks_); }

    // Total resting quantity at a price level, or 0 if there is none.
    Quantity volumeAt(Side side, Price price) const {
        return side == Side::Buy ? volumeAt(bids_, price) : volumeAt(asks_, price);
    }

    // Total number of resting orders across both sides.
    std::size_t orderCount() const noexcept { return index_.size(); }

    // Replaces the contents of `out` with up to `maxLevels` levels of one
    // side, best price first. Reuses `out`'s capacity where possible.
    void depth(Side side, std::size_t maxLevels, std::vector<LevelView>& out) const {
        if (side == Side::Buy) {
            depth(bids_, maxLevels, out);
        } else {
            depth(asks_, maxLevels, out);
        }
    }

    // Calls fn(const Order&) for each order resting at a price level, in time
    // priority order. Does nothing if there is no such level.
    template <typename Fn>
    void forEachOrder(Side side, Price price, Fn&& fn) const {
        if (side == Side::Buy) {
            forEachOrder(bids_, price, fn);
        } else {
            forEachOrder(asks_, price, fn);
        }
    }

private:
    friend struct OrderBookTestPeer;
    friend struct InvariantChecker;

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

    void submitImpl(OrderId id, TraderId trader, Side side, Price price, Quantity qty) {
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

    void cancelImpl(OrderId id) {
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

#ifdef ENGINE_CHECK_INVARIANTS
    // Aborts with a description of the problem if the book is inconsistent.
    void verifyInvariants(const char* operation) const;
#endif

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

    template <typename SideMap>
    static std::optional<Price> bestPrice(const SideMap& side) {
        if (side.empty()) return std::nullopt;
        return side.begin()->first;
    }

    template <typename SideMap>
    static Quantity volumeAt(const SideMap& side, Price price) {
        const auto it = side.find(price);
        return it == side.end() ? 0 : it->second.totalQty;
    }

    template <typename SideMap>
    static void depth(const SideMap& side, std::size_t maxLevels, std::vector<LevelView>& out) {
        out.clear();
        out.reserve(std::min(maxLevels, side.size()));
        for (auto it = side.begin(); it != side.end() && out.size() < maxLevels; ++it) {
            out.push_back({it->first, it->second.totalQty, it->second.orders.size()});
        }
    }

    template <typename SideMap, typename Fn>
    static void forEachOrder(const SideMap& side, Price price, Fn& fn) {
        const auto it = side.find(price);
        if (it == side.end()) return;
        for (const Order& order : it->second.orders) fn(order);
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

#ifdef ENGINE_CHECK_INVARIANTS
// Debug-only invariant checking after every operation (see Invariants.h).
// Compiled out entirely unless ENGINE_CHECK_INVARIANTS is defined.
#include <cinttypes>
#include <cstdio>
#include <cstdlib>

#include "Invariants.h"

inline void engine::OrderBook::verifyInvariants(const char* operation) const {
    const std::optional<InvariantViolation> violation = checkInvariants(*this);
    if (!violation) return;
    std::fprintf(stderr,
                 "engine invariant violated after %s: %s (side=%s, price=%" PRId64
                 ", order=%" PRIu64 ")\n",
                 operation, describe(violation->kind),
                 violation->side == Side::Buy ? "Buy" : "Sell", violation->price,
                 violation->orderId);
    std::fflush(stderr);
    std::abort();
}
#endif

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>

#include "Types.h"

// Consistency checks for OrderBook's internal state. checkInvariants() can be
// called directly (tests do), and when ENGINE_CHECK_INVARIANTS is defined the
// book runs it after every submit and cancel, aborting on a violation.
//
// Like the rest of the engine this header does no I/O.

namespace engine {

class OrderBook;

enum class Invariant : std::uint8_t {
    CrossedBook,
    EmptyLevel,
    NonPositiveRemaining,
    WrongLevelPriceOrSide,
    SeqNotIncreasing,
    TotalQtyMismatch,
    OrderMissingFromIndex,
    IndexEntryMismatch,
    IndexSizeMismatch,
};

constexpr const char* describe(Invariant invariant) noexcept {
    switch (invariant) {
        case Invariant::CrossedBook:
            return "book is crossed: best bid >= best ask";
        case Invariant::EmptyLevel:
            return "price level has no orders";
        case Invariant::NonPositiveRemaining:
            return "resting order has non-positive remaining quantity";
        case Invariant::WrongLevelPriceOrSide:
            return "order's price or side does not match its level";
        case Invariant::SeqNotIncreasing:
            return "sequence numbers do not strictly increase within a level";
        case Invariant::TotalQtyMismatch:
            return "level totalQty does not equal the sum of its orders' remaining quantity";
        case Invariant::OrderMissingFromIndex:
            return "resting order is missing from the ID index";
        case Invariant::IndexEntryMismatch:
            return "index entry does not point at the resting order with its ID, side and price";
        case Invariant::IndexSizeMismatch:
            return "index size does not equal the number of resting orders";
    }
    return "unknown invariant";
}

// The first broken invariant found, and where. Fields that do not apply to a
// particular invariant are left at zero.
struct InvariantViolation {
    Invariant kind;
    Side      side    = Side::Buy;
    Price     price   = 0;
    OrderId   orderId = 0;
};

// Returns the first violated invariant, or nullopt if the book is consistent.
inline std::optional<InvariantViolation> checkInvariants(const OrderBook& book);

}  // namespace engine

// Included after the declarations above so that OrderBook.h can use them
// whichever header is included first.
#include "OrderBook.h"

namespace engine {

// Friend of OrderBook, so it can read the book's private storage.
struct InvariantChecker {
    static std::optional<InvariantViolation> check(const OrderBook& book) {
        std::size_t resting = 0;
        if (auto v = checkSide(book, book.bids_, Side::Buy, resting)) return v;
        if (auto v = checkSide(book, book.asks_, Side::Sell, resting)) return v;

        // Every resting order has a matching index entry (checked above) and
        // IDs are unique, so equal counts mean there are no stray entries.
        if (book.index_.size() != resting) return InvariantViolation{Invariant::IndexSizeMismatch};

        if (!book.bids_.empty() && !book.asks_.empty()) {
            const Price bestBid = book.bids_.begin()->first;
            const Price bestAsk = book.asks_.begin()->first;
            if (bestBid >= bestAsk) {
                return InvariantViolation{Invariant::CrossedBook, Side::Buy, bestBid};
            }
        }
        return std::nullopt;
    }

private:
    template <typename SideMap>
    static std::optional<InvariantViolation> checkSide(const OrderBook& book, const SideMap& levels,
                                                       Side side, std::size_t& resting) {
        for (const auto& [price, level] : levels) {
            if (level.orders.empty()) return InvariantViolation{Invariant::EmptyLevel, side, price};

            Quantity sum = 0;
            const Order* previous = nullptr;
            for (const Order& order : level.orders) {
                const auto violation = [&](Invariant kind) {
                    return InvariantViolation{kind, side, price, order.id};
                };

                if (order.price != price || order.side != side) {
                    return violation(Invariant::WrongLevelPriceOrSide);
                }
                if (order.remaining <= 0) return violation(Invariant::NonPositiveRemaining);
                if (previous != nullptr && order.seq <= previous->seq) {
                    return violation(Invariant::SeqNotIncreasing);
                }

                const auto entry = book.index_.find(order.id);
                if (entry == book.index_.end()) return violation(Invariant::OrderMissingFromIndex);
                const auto& loc = entry->second;
                if (loc.side != side || loc.price != price || &*loc.it != &order) {
                    return violation(Invariant::IndexEntryMismatch);
                }

                sum += order.remaining;
                previous = &order;
                ++resting;
            }

            if (sum != level.totalQty) return InvariantViolation{Invariant::TotalQtyMismatch, side, price};
        }
        return std::nullopt;
    }
};

inline std::optional<InvariantViolation> checkInvariants(const OrderBook& book) {
    return InvariantChecker::check(book);
}

}  // namespace engine

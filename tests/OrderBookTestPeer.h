#pragma once

#include <cstddef>

#include <gtest/gtest.h>

#include "EnumPrinters.h"
#include "OrderBook.h"

// Test-only access to OrderBook's private storage, for checking level totals
// and internal invariants. Level queries move to the public API in P0-06.

namespace engine {

struct OrderBookTestPeer {
    // Total resting quantity at a level, or 0 if the level does not exist.
    static Quantity totalQty(const OrderBook& book, Side side, Price price) {
        return side == Side::Buy ? totalQty(book.bids_, price) : totalQty(book.asks_, price);
    }

    static bool hasLevel(const OrderBook& book, Side side, Price price) {
        return side == Side::Buy ? book.bids_.contains(price) : book.asks_.contains(price);
    }

    // Checks that levels, their totals and the order index agree with each
    // other.
    static void expectInvariants(const OrderBook& book) {
        const std::size_t resting =
            expectSideInvariants(book, book.bids_, Side::Buy) +
            expectSideInvariants(book, book.asks_, Side::Sell);
        EXPECT_EQ(book.index_.size(), resting) << "index size != number of resting orders";

        for (const auto& [id, loc] : book.index_) {
            EXPECT_EQ(loc.it->id, id) << "index entry points at the wrong order";
            EXPECT_EQ(loc.it->side, loc.side) << "order " << id;
            EXPECT_EQ(loc.it->price, loc.price) << "order " << id;
            EXPECT_TRUE(hasLevel(book, loc.side, loc.price)) << "order " << id;
        }
    }

private:
    template <typename SideMap>
    static Quantity totalQty(const SideMap& side, Price price) {
        const auto it = side.find(price);
        return it == side.end() ? 0 : it->second.totalQty;
    }

    // Checks each level on one side and returns the number of orders on it.
    template <typename SideMap>
    static std::size_t expectSideInvariants(const OrderBook& book, const SideMap& levels,
                                            Side side) {
        std::size_t count = 0;
        for (const auto& [price, level] : levels) {
            EXPECT_FALSE(level.orders.empty()) << side << " level " << price << " is empty";

            Quantity sum = 0;
            for (const Order& order : level.orders) {
                EXPECT_EQ(order.side, side) << "order " << order.id;
                EXPECT_EQ(order.price, price) << "order " << order.id;
                EXPECT_GT(order.remaining, 0) << "order " << order.id;
                EXPECT_TRUE(book.index_.contains(order.id)) << "order " << order.id
                                                            << " missing from index";
                sum += order.remaining;
                ++count;
            }
            EXPECT_EQ(level.totalQty, sum) << side << " level " << price;
        }
        return count;
    }
};

}  // namespace engine

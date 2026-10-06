#pragma once

#include <cstddef>

#include <gtest/gtest.h>

#include "EnumPrinters.h"
#include "OrderBook.h"

// Test-only access to OrderBook's private storage, for checking internal
// invariants that the public query API cannot see (chiefly the order index).

namespace engine {

struct OrderBookTestPeer {
    // Checks that levels, their totals and the order index agree with each
    // other.
    static void expectInvariants(const OrderBook& book) {
        const std::size_t resting =
            expectSideInvariants(book, book.bids_, Side::Buy) +
            expectSideInvariants(book, book.asks_, Side::Sell);
        EXPECT_EQ(book.index_.size(), resting) << "index size != number of resting orders";
        EXPECT_EQ(book.orderCount(), resting);

        for (const auto& [id, loc] : book.index_) {
            EXPECT_EQ(loc.it->id, id) << "index entry points at the wrong order";
            EXPECT_EQ(loc.it->side, loc.side) << "order " << id;
            EXPECT_EQ(loc.it->price, loc.price) << "order " << id;
            EXPECT_GT(book.volumeAt(loc.side, loc.price), 0) << "order " << id;
        }
    }

private:
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

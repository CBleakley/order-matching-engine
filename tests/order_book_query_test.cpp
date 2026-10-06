#include <gtest/gtest.h>

#include <optional>
#include <string>
#include <vector>

#include "OrderBook.h"
#include "OrderBookTestPeer.h"
#include "RecordingSink.h"
#include "TypeStrings.h"

// Tests for the read-only query API. Each test is written in terms of the side
// under test and its opposite, and runs once for each side of the book.

namespace engine {

// Printed by GoogleTest in failure messages; found by ADL.
inline std::ostream& operator<<(std::ostream& os, const OrderBook::LevelView& level) {
    return os << "Level{price=" << level.price << ", totalQty=" << level.totalQty
              << ", orderCount=" << level.orderCount << '}';
}

namespace {

constexpr TraderId kAlice = 1;
constexpr TraderId kBob   = 2;
constexpr TraderId kCarol = 3;

using LevelView = OrderBook::LevelView;

// The best bid is 100 and the best ask 101, so books built with these prices
// never cross. Returns the price `ticks` levels behind the best on `side`.
constexpr Price away(Side side, Price ticks) {
    return side == Side::Buy ? 100 - ticks : 101 + ticks;
}

class QueryTest : public ::testing::TestWithParam<Side> {
protected:
    const Side side  = GetParam();
    const Side other = opposite(GetParam());

    void TearDown() override { OrderBookTestPeer::expectInvariants(book); }

    std::optional<Price> best(Side s) const {
        return s == Side::Buy ? book.bestBid() : book.bestAsk();
    }

    std::vector<LevelView> depthOf(Side s, std::size_t maxLevels = 100) const {
        std::vector<LevelView> out;
        book.depth(s, maxLevels, out);
        return out;
    }

    std::vector<OrderId> idsAt(Side s, Price price) const {
        std::vector<OrderId> ids;
        book.forEachOrder(s, price, [&ids](const Order& order) { ids.push_back(order.id); });
        return ids;
    }

    // Rests three levels on `s`, best first in price, submitted out of order:
    //   away(s, 0): 5 + 3 (2 orders), away(s, 1): 4, away(s, 2): 6 + 1 + 2 (3 orders).
    // Uses order IDs starting at `firstId`.
    void restThreeLevels(Side s, OrderId firstId) {
        book.submit(firstId + 0, kAlice, s, away(s, 1), 4);
        book.submit(firstId + 1, kAlice, s, away(s, 0), 5);
        book.submit(firstId + 2, kBob, s, away(s, 2), 6);
        book.submit(firstId + 3, kBob, s, away(s, 0), 3);
        book.submit(firstId + 4, kCarol, s, away(s, 2), 1);
        book.submit(firstId + 5, kCarol, s, away(s, 2), 2);
    }

    std::vector<LevelView> threeLevelsDepth(Side s) const {
        return {{away(s, 0), 8, 2}, {away(s, 1), 4, 1}, {away(s, 2), 9, 3}};
    }

    RecordingSink sink;
    OrderBook     book{sink};
};

// --- Empty book ---

TEST_P(QueryTest, EmptyBook) {
    EXPECT_EQ(best(side), std::nullopt);
    EXPECT_EQ(book.volumeAt(side, away(side, 0)), 0);
    EXPECT_EQ(book.orderCount(), 0u);
    EXPECT_TRUE(idsAt(side, away(side, 0)).empty());

    // depth clears whatever the caller's vector held.
    std::vector<LevelView> out{{1, 2, 3}, {4, 5, 6}};
    book.depth(side, 10, out);
    EXPECT_TRUE(out.empty());
}

// --- One-sided book ---

TEST_P(QueryTest, OneSidedBook) {
    restThreeLevels(side, 1);

    EXPECT_EQ(best(side), away(side, 0));
    EXPECT_EQ(best(other), std::nullopt);

    EXPECT_EQ(book.volumeAt(side, away(side, 0)), 8);
    EXPECT_EQ(book.volumeAt(side, away(side, 1)), 4);
    EXPECT_EQ(book.volumeAt(side, away(side, 2)), 9);
    EXPECT_EQ(book.volumeAt(side, away(side, 3)), 0);   // no level at this price
    EXPECT_EQ(book.volumeAt(other, away(side, 0)), 0);  // same price, other side

    EXPECT_EQ(book.orderCount(), 6u);
    EXPECT_EQ(depthOf(side), threeLevelsDepth(side));
    EXPECT_TRUE(depthOf(other).empty());
}

// --- Populated book ---

TEST_P(QueryTest, PopulatedBook) {
    restThreeLevels(side, 1);
    book.submit(7, kAlice, other, away(other, 0), 10);
    book.submit(8, kBob, other, away(other, 1), 20);

    EXPECT_EQ(best(side), away(side, 0));
    EXPECT_EQ(best(other), away(other, 0));
    EXPECT_EQ(book.orderCount(), 8u);

    EXPECT_EQ(book.volumeAt(other, away(other, 0)), 10);
    EXPECT_EQ(book.volumeAt(other, away(other, 1)), 20);

    EXPECT_EQ(depthOf(side), threeLevelsDepth(side));
    const std::vector<LevelView> otherDepth{{away(other, 0), 10, 1}, {away(other, 1), 20, 1}};
    EXPECT_EQ(depthOf(other), otherDepth);
}

TEST(OrderBookQuery, DepthIsBestPriceFirstOnBothSides) {
    RecordingSink sink;
    OrderBook     book{sink};

    for (const Price p : {98, 100, 99}) book.submit(static_cast<OrderId>(p), kAlice, Side::Buy, p, 1);
    for (const Price p : {103, 101, 102}) book.submit(static_cast<OrderId>(p), kBob, Side::Sell, p, 1);

    std::vector<LevelView> out;
    book.depth(Side::Buy, 10, out);
    const std::vector<LevelView> bids{{100, 1, 1}, {99, 1, 1}, {98, 1, 1}};
    EXPECT_EQ(out, bids);

    book.depth(Side::Sell, 10, out);
    const std::vector<LevelView> asks{{101, 1, 1}, {102, 1, 1}, {103, 1, 1}};
    EXPECT_EQ(out, asks);

    EXPECT_EQ(book.bestBid(), 100);
    EXPECT_EQ(book.bestAsk(), 101);
}

// --- depth: maxLevels and buffer reuse ---

TEST_P(QueryTest, DepthRespectsMaxLevels) {
    restThreeLevels(side, 1);
    const std::vector<LevelView> all = threeLevelsDepth(side);

    EXPECT_TRUE(depthOf(side, 0).empty());
    EXPECT_EQ(depthOf(side, 2), std::vector<LevelView>(all.begin(), all.begin() + 2));
    EXPECT_EQ(depthOf(side, 3), all);
    EXPECT_EQ(depthOf(side, 10), all);
}

TEST_P(QueryTest, DepthReusesCallerBuffer) {
    restThreeLevels(side, 1);

    std::vector<LevelView> out;
    book.depth(side, 3, out);
    ASSERT_EQ(out.size(), 3u);
    const std::size_t capacity = out.capacity();
    const LevelView*  data     = out.data();

    book.depth(side, 1, out);
    const std::vector<LevelView> expected{threeLevelsDepth(side).front()};
    EXPECT_EQ(out, expected);
    EXPECT_EQ(out.capacity(), capacity);
    EXPECT_EQ(out.data(), data);  // no reallocation

    book.depth(side, 3, out);
    EXPECT_EQ(out, threeLevelsDepth(side));
    EXPECT_EQ(out.data(), data);
}

// --- forEachOrder ---

TEST_P(QueryTest, ForEachOrderVisitsInTimePriority) {
    restThreeLevels(side, 1);

    EXPECT_EQ(idsAt(side, away(side, 0)), (std::vector<OrderId>{2, 4}));
    EXPECT_EQ(idsAt(side, away(side, 2)), (std::vector<OrderId>{3, 5, 6}));
    EXPECT_TRUE(idsAt(side, away(side, 3)).empty());
    EXPECT_TRUE(idsAt(other, away(side, 0)).empty());

    // The visitor sees each order's current state.
    std::vector<Quantity> remaining;
    book.forEachOrder(side, away(side, 2),
                      [&remaining](const Order& order) { remaining.push_back(order.remaining); });
    EXPECT_EQ(remaining, (std::vector<Quantity>{6, 1, 2}));
}

TEST_P(QueryTest, ForEachOrderAfterPartialFillAndCancel) {
    restThreeLevels(side, 1);
    const Price level = away(side, 2);

    // Clear the two better levels and take 4 from the front of the third.
    book.submit(10, kCarol, other, level, 8 + 4 + 4);
    book.cancel(5);  // middle order of the level

    std::vector<OrderId>  ids;
    std::vector<Quantity> remaining;
    book.forEachOrder(side, level, [&](const Order& order) {
        ids.push_back(order.id);
        remaining.push_back(order.remaining);
    });
    EXPECT_EQ(ids, (std::vector<OrderId>{3, 6}));
    EXPECT_EQ(remaining, (std::vector<Quantity>{2, 2}));
}

// --- Values after fills and cancels ---

TEST_P(QueryTest, ValuesUpdateAfterSweep) {
    restThreeLevels(side, 1);

    // Clears the best level and takes 3 of the 4 at the second.
    book.submit(10, kCarol, other, away(side, 1), 11);

    EXPECT_EQ(best(side), away(side, 1));
    EXPECT_EQ(best(other), std::nullopt);
    EXPECT_EQ(book.volumeAt(side, away(side, 0)), 0);
    EXPECT_EQ(book.volumeAt(side, away(side, 1)), 1);
    EXPECT_EQ(book.orderCount(), 4u);
    const std::vector<LevelView> expected{{away(side, 1), 1, 1}, {away(side, 2), 9, 3}};
    EXPECT_EQ(depthOf(side), expected);
}

TEST_P(QueryTest, ValuesUpdateAfterAggressorRests) {
    restThreeLevels(side, 1);

    // Sweeps every level and rests the remaining 5 on the other side.
    book.submit(10, kCarol, other, away(side, 2), 21 + 5);

    EXPECT_EQ(best(side), std::nullopt);
    EXPECT_EQ(best(other), away(side, 2));
    EXPECT_EQ(book.orderCount(), 1u);
    EXPECT_TRUE(depthOf(side).empty());
    const std::vector<LevelView> expected{{away(side, 2), 5, 1}};
    EXPECT_EQ(depthOf(other), expected);
}

TEST_P(QueryTest, ValuesUpdateAfterCancels) {
    restThreeLevels(side, 1);

    book.cancel(4);  // one of the two orders at the best level
    EXPECT_EQ(best(side), away(side, 0));
    EXPECT_EQ(book.volumeAt(side, away(side, 0)), 5);
    EXPECT_EQ(book.orderCount(), 5u);

    book.cancel(2);  // last order at the best level
    EXPECT_EQ(best(side), away(side, 1));
    EXPECT_EQ(book.volumeAt(side, away(side, 0)), 0);
    EXPECT_EQ(book.orderCount(), 4u);
    const std::vector<LevelView> expected{{away(side, 1), 4, 1}, {away(side, 2), 9, 3}};
    EXPECT_EQ(depthOf(side), expected);

    for (const OrderId id : {1, 3, 5, 6}) book.cancel(id);
    EXPECT_EQ(best(side), std::nullopt);
    EXPECT_EQ(book.orderCount(), 0u);
    EXPECT_TRUE(depthOf(side).empty());
}

TEST(OrderBookQuery, QueriesDoNotEmitEvents) {
    RecordingSink sink;
    OrderBook     book{sink};
    book.submit(1, kAlice, Side::Buy, 100, 5);
    sink.clear();

    std::vector<LevelView> out;
    (void)book.bestBid();
    (void)book.bestAsk();
    (void)book.volumeAt(Side::Buy, 100);
    (void)book.orderCount();
    book.depth(Side::Buy, 5, out);
    book.forEachOrder(Side::Buy, 100, [](const Order&) {});

    EXPECT_TRUE(sink.empty());
}

INSTANTIATE_TEST_SUITE_P(BothSides, QueryTest, ::testing::Values(Side::Buy, Side::Sell),
                         [](const ::testing::TestParamInfo<Side>& info) {
                             return std::string(toString(info.param)) + "Side";
                         });

}  // namespace
}  // namespace engine

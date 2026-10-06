#include <gtest/gtest.h>

#include <optional>
#include <vector>

#include "RecordingSink.h"
#include "ReferenceOrderBook.h"

// Basic scenarios for the reference engine itself, so that a differential
// failure can be trusted to point at the real engine.

namespace engine {
namespace {

constexpr TraderId kAlice = 1;
constexpr TraderId kBob   = 2;
constexpr TraderId kCarol = 3;

class ReferenceBookTest : public ::testing::Test {
protected:
    RecordingSink      sink;
    ReferenceOrderBook book{sink};
};

TEST_F(ReferenceBookTest, RestsOnEmptyBookAndWhenPricesDoNotCross) {
    book.submit(1, kAlice, Side::Buy, 100, 10);
    book.submit(2, kBob, Side::Sell, 101, 5);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Buy, 100, 10},
        OrderAccepted{2, 2},
        OrderRested{2, Side::Sell, 101, 5},
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(book.orderCount(), 2u);
    EXPECT_EQ(book.bestBid(), 100);
    EXPECT_EQ(book.bestAsk(), 101);
}

TEST_F(ReferenceBookTest, ExactFullFill) {
    book.submit(1, kAlice, Side::Sell, 100, 10);
    book.submit(2, kBob, Side::Buy, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Sell, 100, 10},
        OrderAccepted{2, 2},
        TradeEvent{1, 2, kBob, kAlice, 100, 10, Side::Buy, 3},
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(book.orderCount(), 0u);
    EXPECT_EQ(book.bestBid(), std::nullopt);
    EXPECT_EQ(book.bestAsk(), std::nullopt);
}

TEST_F(ReferenceBookTest, PartialFillOfAggressorRestsRemainder) {
    book.submit(1, kAlice, Side::Buy, 100, 4);
    book.submit(2, kBob, Side::Sell, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Buy, 100, 4},
        OrderAccepted{2, 2},
        TradeEvent{1, 2, kAlice, kBob, 100, 4, Side::Sell, 3},
        OrderRested{2, Side::Sell, 100, 6},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_F(ReferenceBookTest, PartialFillOfRestingOrderKeepsRemainder) {
    book.submit(1, kAlice, Side::Sell, 100, 10);
    book.submit(2, kBob, Side::Buy, 100, 4);
    sink.clear();

    book.cancel(1);
    const std::vector<Event> expected{OrderCancelled{1, 6}};
    EXPECT_EQ(sink.events(), expected);
}

TEST_F(ReferenceBookTest, SweepsLevelsBestPriceFirstAtRestingPrices) {
    book.submit(1, kAlice, Side::Sell, 102, 5);
    book.submit(2, kAlice, Side::Sell, 100, 5);
    book.submit(3, kAlice, Side::Sell, 101, 5);
    book.submit(4, kAlice, Side::Sell, 103, 5);  // beyond the taker's limit
    sink.clear();

    book.submit(5, kBob, Side::Buy, 102, 12);
    const std::vector<Event> expected{
        OrderAccepted{5, 5},
        TradeEvent{2, 5, kBob, kAlice, 100, 5, Side::Buy, 6},
        TradeEvent{3, 5, kBob, kAlice, 101, 5, Side::Buy, 7},
        TradeEvent{1, 5, kBob, kAlice, 102, 2, Side::Buy, 8},
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(book.bestAsk(), 102);
}

TEST_F(ReferenceBookTest, TimePriorityWithinPrice) {
    book.submit(1, kAlice, Side::Buy, 100, 5);
    book.submit(2, kBob, Side::Buy, 100, 5);
    book.submit(3, kAlice, Side::Buy, 101, 1);  // better price, arrives last
    sink.clear();

    book.submit(4, kCarol, Side::Sell, 99, 8);
    const std::vector<Event> expected{
        OrderAccepted{4, 4},
        TradeEvent{3, 4, kAlice, kCarol, 101, 1, Side::Sell, 5},
        TradeEvent{1, 4, kAlice, kCarol, 100, 5, Side::Sell, 6},
        TradeEvent{2, 4, kBob, kCarol, 100, 2, Side::Sell, 7},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_F(ReferenceBookTest, RejectsInvalidSubmits) {
    book.submit(1, kAlice, Side::Buy, 0, 10);
    book.submit(2, kAlice, Side::Buy, 100, 0);
    book.submit(3, kAlice, Side::Buy, 100, 10);
    book.submit(3, kBob, Side::Sell, 100, 10);

    const std::vector<Event> expected{
        OrderRejected{1, RejectReason::InvalidPrice},
        OrderRejected{2, RejectReason::InvalidQuantity},
        OrderAccepted{3, 1},
        OrderRested{3, Side::Buy, 100, 10},
        OrderRejected{3, RejectReason::DuplicateOrderId},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_F(ReferenceBookTest, CancelRemovesOrderAndRejectsUnknownIds) {
    book.submit(1, kAlice, Side::Buy, 100, 10);
    book.cancel(1);
    book.cancel(1);
    book.cancel(99);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Buy, 100, 10},
        OrderCancelled{1, 10},
        OrderRejected{1, RejectReason::UnknownOrderId},
        OrderRejected{99, RejectReason::UnknownOrderId},
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(book.orderCount(), 0u);
}

}  // namespace
}  // namespace engine

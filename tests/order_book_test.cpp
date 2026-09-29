#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "OrderBook.h"
#include "RecordingSink.h"
#include "TypeStrings.h"

// Matching scenarios are written once in terms of the aggressor's side and run
// for both Buy and Sell aggressors, so each side of the book is exercised
// symmetrically. Each test checks the complete event stream, from the first
// submission.

namespace engine {
namespace {

constexpr TraderId kAlice = 1;
constexpr TraderId kBob   = 2;
constexpr TraderId kCarol = 3;
constexpr TraderId kDave  = 4;

// `p` moved `ticks` away from the touch for an order on `side`, i.e. to a
// less aggressive price (lower for a buy, higher for a sell).
constexpr Price lessAggressive(Side side, Price p, Price ticks) {
    return side == Side::Buy ? p - ticks : p + ticks;
}

class MatchingTest : public ::testing::TestWithParam<Side> {
protected:
    // Side of the incoming (aggressive) order, and of the resting orders.
    const Side taker = GetParam();
    const Side maker = opposite(GetParam());

    // Price for a resting order `ticks` behind the best maker price of 100.
    Price makerPrice(Price ticks) const { return lessAggressive(maker, 100, ticks); }

    TradeEvent trade(OrderId makerId, TraderId makerTrader, OrderId takerId, TraderId takerTrader,
                     Price price, Quantity qty, SeqNum seq) const {
        const bool takerBuys = taker == Side::Buy;
        return TradeEvent{
            .makerId       = makerId,
            .takerId       = takerId,
            .buyer         = takerBuys ? takerTrader : makerTrader,
            .seller        = takerBuys ? makerTrader : takerTrader,
            .price         = price,
            .qty           = qty,
            .aggressorSide = taker,
            .seq           = seq,
        };
    }

    RecordingSink sink;
    OrderBook     book{sink};
};

TEST_P(MatchingTest, RestsWhenOppositeSideIsEmpty) {
    book.submit(1, kAlice, taker, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, taker, 100, 10},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(MatchingTest, RestsWhenPricesDoNotCross) {
    book.submit(1, kAlice, maker, 100, 10);
    const Price takerPrice = lessAggressive(taker, 100, 1);  // one tick short of crossing
    book.submit(2, kBob, taker, takerPrice, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 10},
        OrderAccepted{2, 2},
        OrderRested{2, taker, takerPrice, 10},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(MatchingTest, ExactFullFill) {
    book.submit(1, kAlice, maker, 100, 10);
    book.submit(2, kBob, taker, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 10},
        OrderAccepted{2, 2},
        trade(1, kAlice, 2, kBob, 100, 10, 3),
    };
    EXPECT_EQ(sink.events(), expected);

    // Both orders are gone: a new taker order finds nothing to match.
    sink.clear();
    book.submit(3, kCarol, taker, 100, 5);
    const std::vector<Event> after{
        OrderAccepted{3, 4},
        OrderRested{3, taker, 100, 5},
    };
    EXPECT_EQ(sink.events(), after);
}

TEST_P(MatchingTest, PartialFillOfAggressorRestsRemainder) {
    book.submit(1, kAlice, maker, 100, 4);
    book.submit(2, kBob, taker, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 4},
        OrderAccepted{2, 2},
        trade(1, kAlice, 2, kBob, 100, 4, 3),
        OrderRested{2, taker, 100, 6},
    };
    EXPECT_EQ(sink.events(), expected);

    // The remainder is now resting on the taker's side and can be hit.
    sink.clear();
    book.submit(3, kCarol, maker, 100, 6);
    const std::vector<Event> after{
        OrderAccepted{3, 4},
        TradeEvent{
            .makerId       = 2,
            .takerId       = 3,
            .buyer         = taker == Side::Buy ? kBob : kCarol,
            .seller        = taker == Side::Buy ? kCarol : kBob,
            .price         = 100,
            .qty           = 6,
            .aggressorSide = maker,
            .seq           = 5,
        },
    };
    EXPECT_EQ(sink.events(), after);
}

TEST_P(MatchingTest, PartialFillOfRestingOrderLeavesRemainderInBook) {
    book.submit(1, kAlice, maker, 100, 10);
    book.submit(2, kBob, taker, 100, 4);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 10},
        OrderAccepted{2, 2},
        trade(1, kAlice, 2, kBob, 100, 4, 3),
    };
    EXPECT_EQ(sink.events(), expected);

    // The resting order keeps its remaining 6: a larger taker fills exactly
    // that and rests the rest.
    sink.clear();
    book.submit(3, kCarol, taker, 100, 10);
    const std::vector<Event> after{
        OrderAccepted{3, 4},
        trade(1, kAlice, 3, kCarol, 100, 6, 5),
        OrderRested{3, taker, 100, 4},
    };
    EXPECT_EQ(sink.events(), after);
}

TEST_P(MatchingTest, SweepsSeveralPriceLevelsBestFirst) {
    // Levels are submitted out of price order to check the book sorts them.
    book.submit(1, kAlice, maker, makerPrice(1), 5);
    book.submit(2, kBob, maker, makerPrice(0), 5);
    book.submit(3, kCarol, maker, makerPrice(2), 5);
    book.submit(4, kAlice, maker, makerPrice(3), 5);  // beyond the taker's limit

    // Takes all of the best two levels and part of the third, then stops at
    // its limit price, leaving the fourth level untouched.
    book.submit(5, kDave, taker, makerPrice(2), 12);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, makerPrice(1), 5},
        OrderAccepted{2, 2},
        OrderRested{2, maker, makerPrice(0), 5},
        OrderAccepted{3, 3},
        OrderRested{3, maker, makerPrice(2), 5},
        OrderAccepted{4, 4},
        OrderRested{4, maker, makerPrice(3), 5},
        OrderAccepted{5, 5},
        trade(2, kBob, 5, kDave, makerPrice(0), 5, 6),
        trade(1, kAlice, 5, kDave, makerPrice(1), 5, 7),
        trade(3, kCarol, 5, kDave, makerPrice(2), 2, 8),
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(MatchingTest, SweepRestsRemainderAfterExhaustingCrossingLevels) {
    book.submit(1, kAlice, maker, makerPrice(0), 5);
    book.submit(2, kBob, maker, makerPrice(1), 5);
    book.submit(3, kCarol, maker, makerPrice(3), 5);  // beyond the taker's limit

    book.submit(4, kDave, taker, makerPrice(2), 15);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, makerPrice(0), 5},
        OrderAccepted{2, 2},
        OrderRested{2, maker, makerPrice(1), 5},
        OrderAccepted{3, 3},
        OrderRested{3, maker, makerPrice(3), 5},
        OrderAccepted{4, 4},
        trade(1, kAlice, 4, kDave, makerPrice(0), 5, 5),
        trade(2, kBob, 4, kDave, makerPrice(1), 5, 6),
        OrderRested{4, taker, makerPrice(2), 5},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(MatchingTest, TimePriorityWithinPriceLevel) {
    book.submit(1, kAlice, maker, 100, 5);
    book.submit(2, kBob, maker, 100, 5);
    book.submit(3, kCarol, taker, 100, 7);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 5},
        OrderAccepted{2, 2},
        OrderRested{2, maker, 100, 5},
        OrderAccepted{3, 3},
        trade(1, kAlice, 3, kCarol, 100, 5, 4),
        trade(2, kBob, 3, kCarol, 100, 2, 5),
    };
    EXPECT_EQ(sink.events(), expected);

    // Order 2 keeps its place at the front of the level with 3 remaining.
    sink.clear();
    book.submit(4, kDave, taker, 100, 3);
    const std::vector<Event> after{
        OrderAccepted{4, 6},
        trade(2, kBob, 4, kDave, 100, 3, 7),
    };
    EXPECT_EQ(sink.events(), after);
}

TEST_P(MatchingTest, TradesExecuteAtRestingPrice) {
    book.submit(1, kAlice, maker, 100, 10);
    const Price takerPrice = lessAggressive(taker, 100, -5);  // crosses by 5 ticks
    book.submit(2, kBob, taker, takerPrice, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 10},
        OrderAccepted{2, 2},
        trade(1, kAlice, 2, kBob, 100, 10, 3),
    };
    EXPECT_EQ(sink.events(), expected);
}

INSTANTIATE_TEST_SUITE_P(BothSides, MatchingTest, ::testing::Values(Side::Buy, Side::Sell),
                         [](const ::testing::TestParamInfo<Side>& info) {
                             return std::string(toString(info.param)) + "Aggressor";
                         });

// --- Validation ---

TEST(OrderBookValidation, RejectsNonPositivePrice) {
    RecordingSink sink;
    OrderBook     book{sink};

    book.submit(1, kAlice, Side::Buy, 0, 10);
    book.submit(2, kAlice, Side::Sell, -5, 10);

    const std::vector<Event> expected{
        OrderRejected{1, RejectReason::InvalidPrice},
        OrderRejected{2, RejectReason::InvalidPrice},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST(OrderBookValidation, RejectsNonPositiveQuantity) {
    RecordingSink sink;
    OrderBook     book{sink};

    book.submit(1, kAlice, Side::Buy, 100, 0);
    book.submit(2, kAlice, Side::Sell, 100, -3);

    const std::vector<Event> expected{
        OrderRejected{1, RejectReason::InvalidQuantity},
        OrderRejected{2, RejectReason::InvalidQuantity},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST(OrderBookValidation, PriceIsCheckedBeforeQuantity) {
    RecordingSink sink;
    OrderBook     book{sink};

    book.submit(1, kAlice, Side::Buy, 0, 0);

    const std::vector<Event> expected{OrderRejected{1, RejectReason::InvalidPrice}};
    EXPECT_EQ(sink.events(), expected);
}

TEST(OrderBookValidation, RejectsIdOfRestingOrder) {
    RecordingSink sink;
    OrderBook     book{sink};

    book.submit(1, kAlice, Side::Buy, 100, 10);
    // Same ID on either side is a duplicate, and must not match the original.
    book.submit(1, kBob, Side::Sell, 100, 10);
    book.submit(1, kBob, Side::Buy, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Buy, 100, 10},
        OrderRejected{1, RejectReason::DuplicateOrderId},
        OrderRejected{1, RejectReason::DuplicateOrderId},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST(OrderBookValidation, RejectsIdOfPartiallyFilledRestingOrder) {
    RecordingSink sink;
    OrderBook     book{sink};

    book.submit(1, kAlice, Side::Sell, 100, 10);
    book.submit(2, kBob, Side::Buy, 100, 4);
    book.submit(1, kCarol, Side::Buy, 100, 1);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Sell, 100, 10},
        OrderAccepted{2, 2},
        TradeEvent{1, 2, kBob, kAlice, 100, 4, Side::Buy, 3},
        OrderRejected{1, RejectReason::DuplicateOrderId},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST(OrderBookValidation, AcceptsIdOfOrderNoLongerResting) {
    RecordingSink sink;
    OrderBook     book{sink};

    book.submit(1, kAlice, Side::Sell, 100, 10);
    book.submit(2, kBob, Side::Buy, 100, 10);  // fully fills order 1
    book.submit(1, kCarol, Side::Buy, 100, 5);  // order 1 has left the book
    book.submit(2, kDave, Side::Sell, 100, 5);  // order 2 never rested

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Sell, 100, 10},
        OrderAccepted{2, 2},
        TradeEvent{1, 2, kBob, kAlice, 100, 10, Side::Buy, 3},
        OrderAccepted{1, 4},
        OrderRested{1, Side::Buy, 100, 5},
        OrderAccepted{2, 5},
        TradeEvent{1, 2, kCarol, kDave, 100, 5, Side::Sell, 6},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST(OrderBookValidation, RejectedOrdersDoNotConsumeSequenceNumbersOrTouchBook) {
    RecordingSink sink;
    OrderBook     book{sink};

    book.submit(1, kAlice, Side::Sell, 100, 10);
    book.submit(2, kBob, Side::Buy, 0, 10);
    book.submit(3, kBob, Side::Buy, 100, 0);
    book.submit(4, kBob, Side::Buy, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, Side::Sell, 100, 10},
        OrderRejected{2, RejectReason::InvalidPrice},
        OrderRejected{3, RejectReason::InvalidQuantity},
        OrderAccepted{4, 2},
        TradeEvent{1, 4, kBob, kAlice, 100, 10, Side::Buy, 3},
    };
    EXPECT_EQ(sink.events(), expected);
}

}  // namespace
}  // namespace engine

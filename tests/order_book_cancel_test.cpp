#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "OrderBook.h"
#include "OrderBookTestPeer.h"
#include "RecordingSink.h"
#include "TypeStrings.h"

// Cancellation tests, run with the cancelled (resting) orders on each side of
// the book. Every test finishes by checking the book's internal invariants.

namespace engine {
namespace {

constexpr TraderId kAlice = 1;
constexpr TraderId kBob   = 2;
constexpr TraderId kCarol = 3;
constexpr TraderId kDave  = 4;

using Peer = OrderBookTestPeer;

class CancelTest : public ::testing::TestWithParam<Side> {
protected:
    // Side of the resting orders being cancelled, and of incoming orders that
    // hit them.
    const Side maker = GetParam();
    const Side taker = opposite(GetParam());

    // Price one tick behind the best maker price of 100.
    const Price behind = maker == Side::Buy ? 99 : 101;

    void TearDown() override { Peer::expectInvariants(book); }

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

    // Rests orders 1, 2 and 3 (Alice 5, Bob 6, Carol 7) at price 100, using
    // sequence numbers 1-3, then clears the recorded events.
    void restThreeAt100() {
        book.submit(1, kAlice, maker, 100, 5);
        book.submit(2, kBob, maker, 100, 6);
        book.submit(3, kCarol, maker, 100, 7);
        sink.clear();
    }

    RecordingSink sink;
    OrderBook     book{sink};
};

// --- Cancelling from each position in a level ---

TEST_P(CancelTest, CancelFrontOfLevel) {
    restThreeAt100();
    book.cancel(1);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 13);

    // Sweep the level: only 2 and 3 remain, in their original order.
    book.submit(4, kDave, taker, 100, 20);

    const std::vector<Event> expected{
        OrderCancelled{1, 5},
        OrderAccepted{4, 4},
        trade(2, kBob, 4, kDave, 100, 6, 5),
        trade(3, kCarol, 4, kDave, 100, 7, 6),
        OrderRested{4, taker, 100, 7},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(CancelTest, CancelMiddleOfLevel) {
    restThreeAt100();
    book.cancel(2);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 12);

    book.submit(4, kDave, taker, 100, 20);

    const std::vector<Event> expected{
        OrderCancelled{2, 6},
        OrderAccepted{4, 4},
        trade(1, kAlice, 4, kDave, 100, 5, 5),
        trade(3, kCarol, 4, kDave, 100, 7, 6),
        OrderRested{4, taker, 100, 8},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(CancelTest, CancelBackOfLevel) {
    restThreeAt100();
    book.cancel(3);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 11);

    book.submit(4, kDave, taker, 100, 20);

    const std::vector<Event> expected{
        OrderCancelled{3, 7},
        OrderAccepted{4, 4},
        trade(1, kAlice, 4, kDave, 100, 5, 5),
        trade(2, kBob, 4, kDave, 100, 6, 6),
        OrderRested{4, taker, 100, 9},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(CancelTest, MiddleCancelPreservesTimePriority) {
    restThreeAt100();
    book.cancel(2);

    // The first taker fills all of 1 and part of 3; the second takes the rest
    // of 3, which kept its place in the queue.
    book.submit(4, kDave, taker, 100, 8);
    book.submit(5, kDave, taker, 100, 4);

    const std::vector<Event> expected{
        OrderCancelled{2, 6},
        OrderAccepted{4, 4},
        trade(1, kAlice, 4, kDave, 100, 5, 5),
        trade(3, kCarol, 4, kDave, 100, 3, 6),
        OrderAccepted{5, 7},
        trade(3, kCarol, 5, kDave, 100, 4, 8),
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_FALSE(Peer::hasLevel(book, maker, 100));
}

// --- Level removal ---

TEST_P(CancelTest, CancellingOnlyOrderRemovesLevel) {
    book.submit(1, kAlice, maker, 100, 10);
    EXPECT_TRUE(Peer::hasLevel(book, maker, 100));

    book.cancel(1);
    EXPECT_FALSE(Peer::hasLevel(book, maker, 100));
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 0);

    // Nothing left to match: an opposite order at the same price rests.
    book.submit(2, kBob, taker, 100, 10);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 10},
        OrderCancelled{1, 10},
        OrderAccepted{2, 2},
        OrderRested{2, taker, 100, 10},
    };
    EXPECT_EQ(sink.events(), expected);
}

TEST_P(CancelTest, CancellingBestLevelLeavesOthersIntact) {
    book.submit(1, kAlice, maker, 100, 5);
    book.submit(2, kBob, maker, behind, 6);

    book.cancel(1);
    EXPECT_FALSE(Peer::hasLevel(book, maker, 100));
    EXPECT_EQ(Peer::totalQty(book, maker, behind), 6);

    // The next level is now the best.
    sink.clear();
    book.submit(3, kCarol, taker, behind, 6);
    const std::vector<Event> expected{
        OrderAccepted{3, 3},
        trade(2, kBob, 3, kCarol, behind, 6, 4),
    };
    EXPECT_EQ(sink.events(), expected);
}

// --- Remaining quantity ---

TEST_P(CancelTest, CancelPartiallyFilledOrderReportsRemainingQty) {
    book.submit(1, kAlice, maker, 100, 10);
    book.submit(2, kBob, taker, 100, 4);
    book.cancel(1);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 10},
        OrderAccepted{2, 2},
        trade(1, kAlice, 2, kBob, 100, 4, 3),
        OrderCancelled{1, 6},
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_FALSE(Peer::hasLevel(book, maker, 100));
}

// --- Rejections ---

TEST_P(CancelTest, RejectsUnknownId) {
    book.submit(1, kAlice, maker, 100, 10);
    sink.clear();

    book.cancel(42);

    const std::vector<Event> expected{OrderRejected{42, RejectReason::UnknownOrderId}};
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 10);
}

TEST_P(CancelTest, RejectsFilledId) {
    book.submit(1, kAlice, maker, 100, 10);
    book.submit(2, kBob, maker, 100, 5);
    book.submit(3, kCarol, taker, 100, 10);  // fully fills order 1
    sink.clear();

    book.cancel(1);
    book.cancel(3);  // the taker was filled on arrival and never rested

    const std::vector<Event> expected{
        OrderRejected{1, RejectReason::UnknownOrderId},
        OrderRejected{3, RejectReason::UnknownOrderId},
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 5);
}

TEST_P(CancelTest, RejectsAlreadyCancelledId) {
    book.submit(1, kAlice, maker, 100, 10);
    book.submit(2, kBob, maker, 100, 5);
    book.cancel(1);
    sink.clear();

    book.cancel(1);

    const std::vector<Event> expected{OrderRejected{1, RejectReason::UnknownOrderId}};
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 5);
}

TEST_P(CancelTest, CancelledIdCanBeReused) {
    book.submit(1, kAlice, maker, 100, 10);
    book.cancel(1);
    book.submit(1, kBob, maker, 100, 3);

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 10},
        OrderCancelled{1, 10},
        OrderAccepted{1, 2},
        OrderRested{1, maker, 100, 3},
    };
    EXPECT_EQ(sink.events(), expected);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 3);
}

// --- Level totals ---

TEST_P(CancelTest, TotalQtyTracksRestsFillsAndCancels) {
    book.submit(1, kAlice, maker, 100, 10);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 10);

    book.submit(2, kBob, maker, 100, 7);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 17);

    book.submit(3, kCarol, taker, 100, 4);  // partial fill of order 1
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 13);
    Peer::expectInvariants(book);

    book.submit(4, kCarol, taker, 100, 6);  // fills the rest of order 1
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 7);
    Peer::expectInvariants(book);

    book.submit(5, kAlice, maker, 100, 2);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 9);

    book.cancel(2);
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 2);
    Peer::expectInvariants(book);

    book.submit(6, kDave, taker, 100, 2);  // full fill empties the level
    EXPECT_EQ(Peer::totalQty(book, maker, 100), 0);
    EXPECT_FALSE(Peer::hasLevel(book, maker, 100));
}

TEST_P(CancelTest, TotalQtyAcrossSweptLevels) {
    book.submit(1, kAlice, maker, 100, 5);
    book.submit(2, kBob, maker, behind, 5);
    book.submit(3, kCarol, maker, behind, 5);

    // Clears the best level and takes part of the next.
    book.submit(4, kDave, taker, behind, 8);

    EXPECT_FALSE(Peer::hasLevel(book, maker, 100));
    EXPECT_EQ(Peer::totalQty(book, maker, behind), 7);
}

TEST_P(CancelTest, TotalQtyOfRestingTakerRemainder) {
    book.submit(1, kAlice, maker, 100, 4);
    book.submit(2, kBob, taker, 100, 10);  // fills order 1, rests 6

    EXPECT_FALSE(Peer::hasLevel(book, maker, 100));
    EXPECT_EQ(Peer::totalQty(book, taker, 100), 6);

    book.cancel(2);
    EXPECT_FALSE(Peer::hasLevel(book, taker, 100));

    const std::vector<Event> expected{
        OrderAccepted{1, 1},
        OrderRested{1, maker, 100, 4},
        OrderAccepted{2, 2},
        trade(1, kAlice, 2, kBob, 100, 4, 3),
        OrderRested{2, taker, 100, 6},
        OrderCancelled{2, 6},
    };
    EXPECT_EQ(sink.events(), expected);
}

INSTANTIATE_TEST_SUITE_P(BothSides, CancelTest, ::testing::Values(Side::Buy, Side::Sell),
                         [](const ::testing::TestParamInfo<Side>& info) {
                             return std::string(toString(info.param)) + "Resting";
                         });

}  // namespace
}  // namespace engine

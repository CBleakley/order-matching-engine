#include <gtest/gtest.h>

#include <cstdint>
#include <iterator>
#include <optional>

#include "EnumPrinters.h"
#include "Events.h"
#include "Invariants.h"
#include "OrderBook.h"
#include "OrderBookTestPeer.h"

// Tests for checkInvariants(): it accepts every book reachable through the
// public API, and reports the right invariant when the book's internals are
// deliberately corrupted through OrderBookTestPeer.

namespace engine {
namespace {

using Peer = OrderBookTestPeer;

constexpr TraderId kAlice = 1;
constexpr TraderId kBob   = 2;

std::optional<Invariant> brokenInvariant(const OrderBook& book) {
    const auto violation = checkInvariants(book);
    return violation ? std::optional<Invariant>(violation->kind) : std::nullopt;
}

// --- Valid books ---

TEST(InvariantChecker, AcceptsEmptyBook) {
    EventSink sink;
    OrderBook book{sink};
    EXPECT_EQ(checkInvariants(book), std::nullopt);
}

TEST(InvariantChecker, AcceptsBookAfterNormalOperations) {
    EventSink sink;
    OrderBook book{sink};

    book.submit(1, kAlice, Side::Buy, 100, 5);
    book.submit(2, kAlice, Side::Buy, 100, 6);
    book.submit(3, kAlice, Side::Buy, 99, 7);
    book.submit(4, kBob, Side::Sell, 102, 4);
    book.submit(5, kBob, Side::Sell, 101, 3);
    EXPECT_EQ(brokenInvariant(book), std::nullopt);

    book.submit(6, kBob, Side::Sell, 100, 8);  // fills 1, partially fills 2
    EXPECT_EQ(brokenInvariant(book), std::nullopt);

    book.cancel(3);
    book.submit(7, kAlice, Side::Buy, 102, 10);  // sweeps the asks, rests 3
    EXPECT_EQ(brokenInvariant(book), std::nullopt);

    book.cancel(2);
    book.cancel(7);
    EXPECT_EQ(brokenInvariant(book), std::nullopt);
    EXPECT_EQ(book.orderCount(), 0u);
}

TEST(InvariantChecker, AcceptsBookThroughoutRandomOrderFlow) {
    EventSink sink;
    OrderBook book{sink};

    // Small linear congruential generator, so the run is identical everywhere.
    std::uint64_t state = 12345;
    const auto next = [&state](std::uint64_t bound) {
        state = state * 6364136223846793005ULL + 1442695040888963407ULL;
        return (state >> 33) % bound;
    };

    OrderId nextId = 1;
    for (int op = 0; op < 5000; ++op) {
        if (nextId > 1 && next(10) < 3) {
            book.cancel(1 + next(nextId - 1));  // may be resting, filled or cancelled
        } else {
            const Side side = next(2) == 0 ? Side::Buy : Side::Sell;
            const auto price = static_cast<Price>(95 + next(11));
            const auto qty   = static_cast<Quantity>(1 + next(20));
            book.submit(nextId++, static_cast<TraderId>(next(5)), side, price, qty);
        }
        ASSERT_EQ(brokenInvariant(book), std::nullopt) << "after operation " << op;
    }
    EXPECT_GT(book.orderCount(), 0u);  // the run left a non-trivial book
}

// --- Corrupted books ---

// Builds a valid two-sided book:
//   asks: 102 [#5 x3]          101 [#4 x4]
//   bids: 100 [#1 x5, #2 x6]    99 [#3 x7]
class CorruptionTest : public ::testing::Test {
protected:
    void SetUp() override {
        book.submit(1, kAlice, Side::Buy, 100, 5);
        book.submit(2, kAlice, Side::Buy, 100, 6);
        book.submit(3, kAlice, Side::Buy, 99, 7);
        book.submit(4, kBob, Side::Sell, 101, 4);
        book.submit(5, kBob, Side::Sell, 102, 3);
        ASSERT_EQ(checkInvariants(book), std::nullopt);
    }

    auto& bids() { return Peer::bids(book); }
    auto& asks() { return Peer::asks(book); }
    auto& index() { return Peer::index(book); }

    EventSink sink;
    OrderBook book{sink};
};

TEST_F(CorruptionTest, DetectsTotalQtyMismatch) {
    bids().at(100).totalQty += 1;

    const auto violation = checkInvariants(book);
    ASSERT_TRUE(violation.has_value());
    EXPECT_EQ(violation->kind, Invariant::TotalQtyMismatch);
    EXPECT_EQ(violation->side, Side::Buy);
    EXPECT_EQ(violation->price, 100);
}

TEST_F(CorruptionTest, DetectsEmptyLevel) {
    asks()[103];  // creates an empty level

    const auto violation = checkInvariants(book);
    ASSERT_TRUE(violation.has_value());
    EXPECT_EQ(violation->kind, Invariant::EmptyLevel);
    EXPECT_EQ(violation->side, Side::Sell);
    EXPECT_EQ(violation->price, 103);
}

TEST_F(CorruptionTest, DetectsNonPositiveRemaining) {
    auto& level = bids().at(100);
    level.orders.front().remaining = 0;
    level.totalQty -= 5;  // keep the total consistent so only this rule fails

    const auto violation = checkInvariants(book);
    ASSERT_TRUE(violation.has_value());
    EXPECT_EQ(violation->kind, Invariant::NonPositiveRemaining);
    EXPECT_EQ(violation->orderId, 1u);
}

TEST_F(CorruptionTest, DetectsOrderAtWrongPrice) {
    bids().at(99).orders.front().price = 98;
    EXPECT_EQ(brokenInvariant(book), Invariant::WrongLevelPriceOrSide);
}

TEST_F(CorruptionTest, DetectsOrderOnWrongSide) {
    asks().at(101).orders.front().side = Side::Buy;
    EXPECT_EQ(brokenInvariant(book), Invariant::WrongLevelPriceOrSide);
}

TEST_F(CorruptionTest, DetectsSequenceOutOfOrder) {
    // Move order 2 in front of order 1; iterators (and the index) stay valid.
    auto& orders = bids().at(100).orders;
    orders.splice(orders.begin(), orders, std::next(orders.begin()));

    const auto violation = checkInvariants(book);
    ASSERT_TRUE(violation.has_value());
    EXPECT_EQ(violation->kind, Invariant::SeqNotIncreasing);
    EXPECT_EQ(violation->orderId, 1u);
}

TEST_F(CorruptionTest, DetectsOrderMissingFromIndex) {
    index().erase(3);

    const auto violation = checkInvariants(book);
    ASSERT_TRUE(violation.has_value());
    EXPECT_EQ(violation->kind, Invariant::OrderMissingFromIndex);
    EXPECT_EQ(violation->orderId, 3u);
}

TEST_F(CorruptionTest, DetectsIndexEntryWithWrongPrice) {
    index().at(1).price = 99;
    EXPECT_EQ(brokenInvariant(book), Invariant::IndexEntryMismatch);
}

TEST_F(CorruptionTest, DetectsIndexEntryPointingAtAnotherOrder) {
    index().at(1).it = index().at(2).it;
    EXPECT_EQ(brokenInvariant(book), Invariant::IndexEntryMismatch);
}

TEST_F(CorruptionTest, DetectsStrayIndexEntry) {
    index().emplace(42, index().at(1));
    EXPECT_EQ(brokenInvariant(book), Invariant::IndexSizeMismatch);
}

TEST_F(CorruptionTest, DetectsCrossedBook) {
    // A fully consistent bid at 102, above the best ask of 101.
    auto& level = bids()[102];
    level.orders.push_back(Order{6, kAlice, Side::Buy, 102, 1, 100});
    level.totalQty = 1;
    auto location  = index().at(1);
    location.price = 102;
    location.it    = std::prev(level.orders.end());
    index().emplace(6, location);

    const auto violation = checkInvariants(book);
    ASSERT_TRUE(violation.has_value());
    EXPECT_EQ(violation->kind, Invariant::CrossedBook);
    EXPECT_EQ(violation->price, 102);
}

// --- Automatic checking (ENGINE_CHECK_INVARIANTS) ---

#ifdef ENGINE_CHECK_INVARIANTS

using CorruptionDeathTest = CorruptionTest;

TEST_F(CorruptionDeathTest, SubmitAbortsOnCorruptedBook) {
    bids().at(100).totalQty += 1;
    EXPECT_DEATH(book.submit(10, kBob, Side::Sell, 105, 1),
                 "invariant violated after submit: level totalQty");
}

TEST_F(CorruptionDeathTest, CancelAbortsOnCorruptedBook) {
    index().erase(3);
    EXPECT_DEATH(book.cancel(5), "invariant violated after cancel: resting order is missing");
}

#else

TEST_F(CorruptionTest, ChecksAreCompiledOutWhenDisabled) {
    bids().at(100).totalQty += 1;
    book.submit(10, kBob, Side::Sell, 105, 1);  // would abort with checks enabled
    book.cancel(10);
    EXPECT_EQ(brokenInvariant(book), Invariant::TotalQtyMismatch);
}

#endif

}  // namespace
}  // namespace engine

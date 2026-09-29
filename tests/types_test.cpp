#include "Types.h"
#include "TypeStrings.h"
#include "EnumPrinters.h"

#include <gtest/gtest.h>

using namespace engine;

TEST(Side, OppositeFlipsSide) {
    EXPECT_EQ(opposite(Side::Buy), Side::Sell);
    EXPECT_EQ(opposite(Side::Sell), Side::Buy);
}

TEST(Side, OppositeIsInvolution) {
    for (Side side : {Side::Buy, Side::Sell}) {
        EXPECT_EQ(opposite(opposite(side)), side);
    }
}

TEST(Side, ToString) {
    EXPECT_EQ(toString(Side::Buy), "Buy");
    EXPECT_EQ(toString(Side::Sell), "Sell");
}

TEST(RejectReason, ToString) {
    EXPECT_EQ(toString(RejectReason::InvalidPrice), "InvalidPrice");
    EXPECT_EQ(toString(RejectReason::InvalidQuantity), "InvalidQuantity");
    EXPECT_EQ(toString(RejectReason::DuplicateOrderId), "DuplicateOrderId");
    EXPECT_EQ(toString(RejectReason::UnknownOrderId), "UnknownOrderId");
}

TEST(TypeStrings, OutOfRangeValuesMapToUnknown) {
    EXPECT_EQ(toString(static_cast<Side>(99)), "Unknown");
    EXPECT_EQ(toString(static_cast<RejectReason>(99)), "Unknown");
}

TEST(TypeStrings, UsableAtCompileTime) {
    static_assert(toString(Side::Buy) == "Buy");
    static_assert(toString(RejectReason::UnknownOrderId) == "UnknownOrderId");
}

TEST(Order, AggregateInitialization) {
    Order order{.id = 1, .trader = 7, .side = Side::Sell, .price = 10'050, .remaining = 25, .seq = 3};

    EXPECT_EQ(order.id, 1u);
    EXPECT_EQ(order.trader, 7u);
    EXPECT_EQ(order.side, Side::Sell);
    EXPECT_EQ(order.price, 10'050);
    EXPECT_EQ(order.remaining, 25);
    EXPECT_EQ(order.seq, 3u);
}

#include <gtest/gtest.h>
#include "OrderBook.h"

// Placeholder so the test target builds against the engine and CTest has
// something to run. Real order book tests come in later tickets.
TEST(Placeholder, OrderKeepsConstructorValues) {
    Order order(OrderType::Buy, 100, 10, "alice");

    EXPECT_EQ(order.getType(), OrderType::Buy);
    EXPECT_EQ(order.getPrice(), 100);
    EXPECT_EQ(order.getQuantity(), 10);
    EXPECT_EQ(order.getTraderName(), "alice");
}

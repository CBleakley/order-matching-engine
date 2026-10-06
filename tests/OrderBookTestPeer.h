#pragma once

#include <gtest/gtest.h>

#include "EnumPrinters.h"
#include "Invariants.h"
#include "OrderBook.h"

// Test-only access to OrderBook's private storage. Lets tests assert the book
// is consistent, and deliberately corrupt it to check the invariant checker.

namespace engine {

struct OrderBookTestPeer {
    // Records a test failure describing the first broken invariant, if any.
    static void expectInvariants(const OrderBook& book) {
        if (const auto v = checkInvariants(book)) {
            ADD_FAILURE() << "invariant violated: " << describe(v->kind) << " (side=" << v->side
                          << ", price=" << v->price << ", order=" << v->orderId << ')';
        }
    }

    // Mutable access to the book's storage, for corrupting it in tests.
    static auto& bids(OrderBook& book) { return book.bids_; }
    static auto& asks(OrderBook& book) { return book.asks_; }
    static auto& index(OrderBook& book) { return book.index_; }
};

}  // namespace engine

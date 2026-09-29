#pragma once

#include <cstdint>

// Core domain types for the matching engine. This header must stay
// self-contained and free of I/O and string dependencies; human-readable
// conversions live in TypeStrings.h.

namespace engine {

using OrderId  = std::uint64_t;
using TraderId = std::uint32_t;
using Price    = std::int64_t;  // integer ticks
using Quantity = std::int64_t;
using SeqNum   = std::uint64_t;

enum class Side : std::uint8_t { Buy, Sell };

struct Order {
    OrderId  id;
    TraderId trader;
    Side     side;
    Price    price;
    Quantity remaining;
    SeqNum   seq;  // assigned by the engine on arrival
};

enum class RejectReason : std::uint8_t {
    InvalidPrice,
    InvalidQuantity,
    DuplicateOrderId,
    UnknownOrderId,
};

constexpr Side opposite(Side side) noexcept {
    return side == Side::Buy ? Side::Sell : Side::Buy;
}

}  // namespace engine

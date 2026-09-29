#pragma once

#include <string_view>

#include "Types.h"

// Human-readable names for engine enums. Kept separate from Types.h so the
// engine core does not depend on string handling.

namespace engine {

constexpr std::string_view toString(Side side) noexcept {
    switch (side) {
        case Side::Buy:  return "Buy";
        case Side::Sell: return "Sell";
    }
    return "Unknown";
}

constexpr std::string_view toString(RejectReason reason) noexcept {
    switch (reason) {
        case RejectReason::InvalidPrice:     return "InvalidPrice";
        case RejectReason::InvalidQuantity:  return "InvalidQuantity";
        case RejectReason::DuplicateOrderId: return "DuplicateOrderId";
        case RejectReason::UnknownOrderId:   return "UnknownOrderId";
    }
    return "Unknown";
}

}  // namespace engine

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <variant>

#include "Instrument.h"
#include "Types.h"

// Conversions between decimal price strings and integer ticks, done on digits
// and integers only (no floating point). The rules match the TypeScript helpers
// (shared/src/price.ts); both are tested against protocol/fixtures/prices.json.

namespace engine_service {

enum class PriceParseError : std::uint8_t { Empty, InvalidFormat, TooManyDecimals, OutOfRange };

// The error codes used by the shared fixtures and the TypeScript helpers.
constexpr std::string_view toString(PriceParseError error) noexcept {
    switch (error) {
        case PriceParseError::Empty:           return "empty";
        case PriceParseError::InvalidFormat:   return "invalid-format";
        case PriceParseError::TooManyDecimals: return "too-many-decimals";
        case PriceParseError::OutOfRange:      return "out-of-range";
    }
    return "unknown";
}

using PriceParseResult = std::variant<engine::Price, PriceParseError>;

namespace detail {

constexpr bool isAsciiDigit(char c) noexcept { return c >= '0' && c <= '9'; }

constexpr bool allDigits(std::string_view text) noexcept {
    for (const char c : text) {
        if (!isAsciiDigit(c)) return false;
    }
    return true;
}

}  // namespace detail

// Parses a plain decimal such as "142.5" into ticks (14250 with 2 decimals).
// Accepts only digits with an optional '.' followed by at least one digit;
// rejects more decimals than the instrument allows and prices outside
// [minPriceTicks, maxPriceTicks].
inline PriceParseResult parseDecimalToTicks(std::string_view input,
                                            const InstrumentConfig& instrument) {
    if (input.empty()) return PriceParseError::Empty;

    const std::size_t dot = input.find('.');
    const std::string_view whole = input.substr(0, dot);
    const std::string_view fraction =
        dot == std::string_view::npos ? std::string_view{} : input.substr(dot + 1);
    if (whole.empty() || !detail::allDigits(whole) || !detail::allDigits(fraction) ||
        (dot != std::string_view::npos && fraction.empty())) {
        return PriceParseError::InvalidFormat;
    }
    const auto decimals = static_cast<std::size_t>(instrument.priceDecimals);
    if (fraction.size() > decimals) return PriceParseError::TooManyDecimals;

    // maxPriceTicks <= 2^53 - 1, so value * 10 + 9 cannot overflow before the
    // early exit.
    engine::Price value = 0;
    const auto append = [&](char digit) {
        value = value * 10 + (digit - '0');
        return value <= instrument.maxPriceTicks;
    };
    for (const char c : whole) {
        if (!append(c)) return PriceParseError::OutOfRange;
    }
    for (std::size_t i = 0; i < decimals; ++i) {
        if (!append(i < fraction.size() ? fraction[i] : '0')) return PriceParseError::OutOfRange;
    }
    if (value < instrument.minPriceTicks) return PriceParseError::OutOfRange;
    return value;
}

// Formats ticks with exactly priceDecimals places: 14250 -> "142.50". Accepts
// any value, including negatives.
inline std::string ticksToDecimalString(engine::Price ticks, const InstrumentConfig& instrument) {
    // Unsigned magnitude, so INT64_MIN does not overflow on negation.
    const std::uint64_t magnitude =
        ticks < 0 ? ~static_cast<std::uint64_t>(ticks) + 1 : static_cast<std::uint64_t>(ticks);
    std::string digits = std::to_string(magnitude);
    const auto decimals = static_cast<std::size_t>(instrument.priceDecimals);
    if (digits.size() <= decimals) digits.insert(0, decimals + 1 - digits.size(), '0');
    if (decimals > 0) digits.insert(digits.size() - decimals, 1, '.');
    if (ticks < 0) digits.insert(0, 1, '-');
    return digits;
}

}  // namespace engine_service

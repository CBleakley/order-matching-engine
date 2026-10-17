#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

#include "Types.h"

// The single tradable instrument, read from protocol/instrument.json at
// startup. The validation rules match the TypeScript loader
// (shared/src/instrument.ts); protocol/fixtures/instrument-configs.json keeps
// the two in step.

namespace engine_service {

struct InstrumentConfig {
    std::string      symbol;
    std::string      name;
    std::string      tickSize;       // e.g. "0.01"; always 10^-priceDecimals
    int              priceDecimals;
    engine::Price    minPriceTicks;
    engine::Price    maxPriceTicks;
    engine::Quantity maxOrderQty;
    engine::Price    referencePriceTicks;  // the simulator's initial anchor
};

class InstrumentConfigError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

constexpr int kMaxPriceDecimals = 8;

// 2^53 - 1: the largest integer a JavaScript number holds exactly. Prices and
// notionals (price * quantity) cross into the TypeScript gateway, so the
// largest notional must not exceed it.
constexpr std::int64_t kMaxSafeInteger = (std::int64_t{1} << 53) - 1;

// The tick size that matches a number of decimals: "1", "0.1", "0.01", ...
inline std::string tickSizeForDecimals(int decimals) {
    if (decimals <= 0) return "1";
    return "0." + std::string(static_cast<std::size_t>(decimals - 1), '0') + "1";
}

namespace detail {

[[noreturn]] inline void fail(std::string_view field, std::string_view problem) {
    throw InstrumentConfigError("Invalid instrument config: " + std::string(field) + " " +
                                std::string(problem));
}

inline const nlohmann::json& field(const nlohmann::json& object, const char* key) {
    const auto it = object.find(key);
    if (it == object.end()) fail(key, "is missing");
    return *it;
}

inline std::string getString(const nlohmann::json& object, const char* key) {
    const nlohmann::json& value = field(object, key);
    if (!value.is_string()) fail(key, "must be a string");
    return value.get<std::string>();
}

// Integers only: 1.5 and 1.0 are both rejected, as are values outside the
// range a JavaScript number holds exactly, so both loaders accept the same files.
inline std::int64_t getInteger(const nlohmann::json& object, const char* key) {
    const nlohmann::json& value = field(object, key);
    if (value.is_number_unsigned()) {
        const auto unsignedValue = value.get<std::uint64_t>();
        if (unsignedValue > static_cast<std::uint64_t>(kMaxSafeInteger)) {
            fail(key, "must not exceed 2^53 - 1");
        }
        return static_cast<std::int64_t>(unsignedValue);
    }
    if (value.is_number_integer()) {
        const auto signedValue = value.get<std::int64_t>();
        if (signedValue < -kMaxSafeInteger) fail(key, "must not be below -(2^53 - 1)");
        return signedValue;
    }
    fail(key, "must be an integer");
}

inline bool isValidSymbol(std::string_view symbol) {
    if (symbol.empty() || symbol.size() > 16) return false;
    for (const char c : symbol) {
        const bool upper = c >= 'A' && c <= 'Z';
        const bool digit = c >= '0' && c <= '9';
        if (!upper && !digit) return false;
    }
    return true;
}

}  // namespace detail

// Validates an already-parsed JSON value. Throws InstrumentConfigError naming
// the first problem found.
inline InstrumentConfig parseInstrumentConfig(const nlohmann::json& json) {
    using detail::fail;

    if (!json.is_object()) fail("config", "must be a JSON object");
    constexpr const char* kKeys[] = {"symbol",        "name",          "tickSize",
                                     "priceDecimals", "minPriceTicks", "maxPriceTicks",
                                     "maxOrderQty",   "referencePriceTicks"};
    for (const auto& [key, value] : json.items()) {
        bool known = false;
        for (const char* expected : kKeys) known = known || key == expected;
        if (!known) fail(key, "is not a recognised key");
    }

    InstrumentConfig config{
        .symbol              = detail::getString(json, "symbol"),
        .name                = detail::getString(json, "name"),
        .tickSize            = detail::getString(json, "tickSize"),
        .priceDecimals       = 0,
        .minPriceTicks       = detail::getInteger(json, "minPriceTicks"),
        .maxPriceTicks       = detail::getInteger(json, "maxPriceTicks"),
        .maxOrderQty         = detail::getInteger(json, "maxOrderQty"),
        .referencePriceTicks = detail::getInteger(json, "referencePriceTicks"),
    };

    const std::int64_t decimals = detail::getInteger(json, "priceDecimals");
    if (decimals < 0 || decimals > kMaxPriceDecimals) fail("priceDecimals", "must be 0 to 8");
    config.priceDecimals = static_cast<int>(decimals);

    if (!detail::isValidSymbol(config.symbol)) {
        fail("symbol", "must be 1-16 characters A-Z or 0-9");
    }
    if (config.name.empty()) fail("name", "must not be empty");
    if (config.tickSize != tickSizeForDecimals(config.priceDecimals)) {
        fail("tickSize", "must be \"" + tickSizeForDecimals(config.priceDecimals) +
                             "\" to agree with priceDecimals " +
                             std::to_string(config.priceDecimals));
    }
    if (config.minPriceTicks < 1) fail("minPriceTicks", "must be at least 1");
    if (config.maxPriceTicks < config.minPriceTicks) {
        fail("maxPriceTicks", "must be at least minPriceTicks");
    }
    if (config.referencePriceTicks < config.minPriceTicks ||
        config.referencePriceTicks > config.maxPriceTicks) {
        fail("referencePriceTicks", "must be between minPriceTicks and maxPriceTicks");
    }
    if (config.maxOrderQty < 1) fail("maxOrderQty", "must be at least 1");
    // Division avoids overflowing the multiplication.
    if (config.maxPriceTicks > kMaxSafeInteger / config.maxOrderQty) {
        fail("maxOrderQty", "times maxPriceTicks must not exceed 2^53 - 1");
    }
    return config;
}

// Parses and validates JSON text.
inline InstrumentConfig parseInstrumentConfigText(std::string_view text) {
    nlohmann::json json;
    try {
        json = nlohmann::json::parse(text);
    } catch (const nlohmann::json::parse_error& e) {
        throw InstrumentConfigError(std::string("Invalid instrument config: malformed JSON: ") +
                                    e.what());
    }
    return parseInstrumentConfig(json);
}

// Reads and validates an instrument config file.
inline InstrumentConfig loadInstrumentConfig(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        throw InstrumentConfigError("Cannot open instrument config: " + path.string());
    }
    std::ostringstream contents;
    contents << in.rdbuf();
    try {
        return parseInstrumentConfigText(contents.str());
    } catch (const InstrumentConfigError& e) {
        throw InstrumentConfigError(path.string() + ": " + e.what());
    }
}

}  // namespace engine_service

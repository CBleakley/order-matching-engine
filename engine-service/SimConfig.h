#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

#include "Types.h"

// Parameters for the market simulator, read from the JSON file given with
// --sim-config. Every key is optional and takes the default below; unknown
// keys are rejected so a typo cannot silently fall back to a default.
// engine-service/sim-config.json lists every key with its default.

namespace engine_service {

// Order sizes: min + an exponential with mean (mean - min), rounded and
// capped at max. Most orders are small, with occasional large ones.
struct QtyDistribution {
    engine::Quantity min;
    engine::Quantity max;
    double           mean;

    bool operator==(const QtyDistribution&) const = default;
};

// The fair value process, one step per simulated second:
//   vol   = clamp(vol * exp(volOfVol * N), volMin, volMax)
//   trend = trendDecay * trend + trendScale * vol * N
//   pull  = meanReversion * ln(anchor / p)
//   p     = p * exp(vol * N + trend + pull)
struct FairValueConfig {
    double initialVol    = 0.0008;
    double volMin        = 0.0003;
    double volMax        = 0.0016;
    double volOfVol      = 0.02;
    double trendDecay    = 0.995;
    double trendScale    = 0.004;
    double meanReversion = 0.0004;

    bool operator==(const FairValueConfig&) const = default;
};

// Quote a bid and an ask around fair value. Maker i quotes
// halfSpreadTicks + i * halfSpreadStepTicks either side of it.
struct MarketMakerConfig {
    std::uint32_t   count               = 4;
    engine::Price   halfSpreadTicks     = 2;
    engine::Price   halfSpreadStepTicks = 1;
    QtyDistribution qty{.min = 50, .max = 300, .mean = 120};
    double          refreshMinSeconds     = 1.0;
    double          refreshMaxSeconds     = 3.0;
    engine::Price   requoteThresholdTicks = 3;  // requote early when fair value moves this far

    bool operator==(const MarketMakerConfig&) const = default;
};

// Arrive as a Poisson process and send marketable limit orders a few ticks
// through the touch; any unfilled remainder is cancelled at once.
struct TakerConfig {
    std::uint32_t   count           = 5;
    double          ratePerSecond   = 2.0;  // arrivals across all takers
    double          sideBias        = 0.4;  // how far P(buy) leans from 0.5 toward fair value
    double          biasScaleTicks  = 5.0;  // fair value - last trade at which the lean is full
    engine::Price   throughTicksMin = 1;
    engine::Price   throughTicksMax = 3;
    QtyDistribution qty{.min = 1, .max = 200, .mean = 30};

    bool operator==(const TakerConfig&) const = default;
};

// Rest orders a few ticks behind the touch for a while, giving the book depth.
struct LiquidityProviderConfig {
    std::uint32_t   count          = 3;
    double          ratePerSecond  = 0.5;  // arrivals across all providers
    engine::Price   behindTicksMin = 2;
    engine::Price   behindTicksMax = 12;
    QtyDistribution qty{.min = 10, .max = 400, .mean = 100};
    double          lifetimeMeanSeconds = 60.0;

    bool operator==(const LiquidityProviderConfig&) const = default;
};

// Simulated traders get trader IDs 1..totalAgents(), makers first, then
// takers, then providers. They must stay below this.
constexpr std::uint32_t kFirstNonSimTraderId = 1'000;

struct SimConfig {
    FairValueConfig         fairValue;
    MarketMakerConfig       marketMakers;
    TakerConfig             takers;
    LiquidityProviderConfig liquidityProviders;

    std::uint32_t totalAgents() const noexcept {
        return marketMakers.count + takers.count + liquidityProviders.count;
    }

    bool operator==(const SimConfig&) const = default;
};

class SimConfigError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

namespace sim_config_detail {

[[noreturn]] inline void fail(std::string_view path, std::string_view problem) {
    throw SimConfigError("Invalid sim config: " + std::string(path) + " " + std::string(problem));
}

inline std::string join(std::string_view path, std::string_view key) {
    return path.empty() ? std::string(key) : std::string(path) + "." + std::string(key);
}

// Checks that `json` is an object whose keys are all in `known`.
inline void checkObject(const nlohmann::json& json, std::string_view path,
                        std::initializer_list<std::string_view> known) {
    if (!json.is_object()) fail(path.empty() ? "config" : path, "must be a JSON object");
    for (const auto& [key, value] : json.items()) {
        bool found = false;
        for (const std::string_view k : known) found = found || key == k;
        if (!found) fail(join(path, key), "is not a recognised key");
    }
}

inline void readNumber(const nlohmann::json& object, std::string_view path, const char* key,
                       double& out) {
    const auto it = object.find(key);
    if (it == object.end()) return;
    if (!it->is_number()) fail(join(path, key), "must be a number");
    out = it->get<double>();
}

// Integers only, within [lo, hi].
template <class Int>
void readInteger(const nlohmann::json& object, std::string_view path, const char* key,
                 std::int64_t lo, std::int64_t hi, Int& out) {
    const auto it = object.find(key);
    if (it == object.end()) return;
    if (!it->is_number_integer()) fail(join(path, key), "must be an integer");
    // Unsigned values may not fit in int64_t, so compare them unsigned.
    const bool tooBig = it->is_number_unsigned()
                            ? it->get<std::uint64_t>() > static_cast<std::uint64_t>(hi)
                            : it->get<std::int64_t>() > hi;
    if (tooBig) fail(join(path, key), "must be at most " + std::to_string(hi));
    const auto value = it->get<std::int64_t>();
    if (value < lo) fail(join(path, key), "must be at least " + std::to_string(lo));
    out = static_cast<Int>(value);
}

constexpr std::int64_t kMaxTicks = std::int64_t{1} << 40;  // far beyond any sane setting

inline void readQty(const nlohmann::json& object, std::string_view path, QtyDistribution& out) {
    const auto it = object.find("qty");
    if (it == object.end()) return;
    const std::string qtyPath = join(path, "qty");
    checkObject(*it, qtyPath, {"min", "max", "mean"});
    readInteger(*it, qtyPath, "min", 1, kMaxTicks, out.min);
    readInteger(*it, qtyPath, "max", 1, kMaxTicks, out.max);
    readNumber(*it, qtyPath, "mean", out.mean);
    if (out.max < out.min) fail(join(qtyPath, "max"), "must be at least min");
    if (!(out.mean >= static_cast<double>(out.min) && out.mean <= static_cast<double>(out.max))) {
        fail(join(qtyPath, "mean"), "must be between min and max");
    }
}

inline void requirePositive(double value, std::string_view path) {
    if (!(value > 0.0)) fail(path, "must be positive");
}

inline void parseFairValue(const nlohmann::json& json, FairValueConfig& c) {
    constexpr std::string_view p = "fairValue";
    checkObject(json, p, {"initialVol", "volMin", "volMax", "volOfVol", "trendDecay",
                          "trendScale", "meanReversion"});
    readNumber(json, p, "initialVol", c.initialVol);
    readNumber(json, p, "volMin", c.volMin);
    readNumber(json, p, "volMax", c.volMax);
    readNumber(json, p, "volOfVol", c.volOfVol);
    readNumber(json, p, "trendDecay", c.trendDecay);
    readNumber(json, p, "trendScale", c.trendScale);
    readNumber(json, p, "meanReversion", c.meanReversion);
    requirePositive(c.volMin, "fairValue.volMin");
    if (!(c.volMax >= c.volMin)) fail("fairValue.volMax", "must be at least volMin");
    if (!(c.initialVol >= c.volMin && c.initialVol <= c.volMax)) {
        fail("fairValue.initialVol", "must be between volMin and volMax");
    }
    if (!(c.volMax <= 0.1)) fail("fairValue.volMax", "must be at most 0.1");
    if (!(c.volOfVol >= 0.0 && c.volOfVol <= 1.0)) fail("fairValue.volOfVol", "must be 0 to 1");
    if (!(c.trendDecay >= 0.0 && c.trendDecay < 1.0)) {
        fail("fairValue.trendDecay", "must be at least 0 and below 1");
    }
    if (!(c.trendScale >= 0.0 && c.trendScale <= 1.0)) fail("fairValue.trendScale", "must be 0 to 1");
    if (!(c.meanReversion >= 0.0 && c.meanReversion <= 1.0)) {
        fail("fairValue.meanReversion", "must be 0 to 1");
    }
}

inline void parseMarketMakers(const nlohmann::json& json, MarketMakerConfig& c) {
    constexpr std::string_view p = "marketMakers";
    checkObject(json, p, {"count", "halfSpreadTicks", "halfSpreadStepTicks", "qty",
                          "refreshMinSeconds", "refreshMaxSeconds", "requoteThresholdTicks"});
    readInteger(json, p, "count", 0, kFirstNonSimTraderId - 1, c.count);
    readInteger(json, p, "halfSpreadTicks", 1, kMaxTicks, c.halfSpreadTicks);
    readInteger(json, p, "halfSpreadStepTicks", 0, kMaxTicks, c.halfSpreadStepTicks);
    readQty(json, p, c.qty);
    readNumber(json, p, "refreshMinSeconds", c.refreshMinSeconds);
    readNumber(json, p, "refreshMaxSeconds", c.refreshMaxSeconds);
    readInteger(json, p, "requoteThresholdTicks", 1, kMaxTicks, c.requoteThresholdTicks);
    requirePositive(c.refreshMinSeconds, "marketMakers.refreshMinSeconds");
    if (!(c.refreshMaxSeconds >= c.refreshMinSeconds)) {
        fail("marketMakers.refreshMaxSeconds", "must be at least refreshMinSeconds");
    }
}

inline void parseTakers(const nlohmann::json& json, TakerConfig& c) {
    constexpr std::string_view p = "takers";
    checkObject(json, p, {"count", "ratePerSecond", "sideBias", "biasScaleTicks",
                          "throughTicksMin", "throughTicksMax", "qty"});
    readInteger(json, p, "count", 0, kFirstNonSimTraderId - 1, c.count);
    readNumber(json, p, "ratePerSecond", c.ratePerSecond);
    readNumber(json, p, "sideBias", c.sideBias);
    readNumber(json, p, "biasScaleTicks", c.biasScaleTicks);
    readInteger(json, p, "throughTicksMin", 0, kMaxTicks, c.throughTicksMin);
    readInteger(json, p, "throughTicksMax", 0, kMaxTicks, c.throughTicksMax);
    readQty(json, p, c.qty);
    requirePositive(c.ratePerSecond, "takers.ratePerSecond");
    if (!(c.sideBias >= 0.0 && c.sideBias <= 0.5)) fail("takers.sideBias", "must be 0 to 0.5");
    requirePositive(c.biasScaleTicks, "takers.biasScaleTicks");
    if (c.throughTicksMax < c.throughTicksMin) {
        fail("takers.throughTicksMax", "must be at least throughTicksMin");
    }
}

inline void parseLiquidityProviders(const nlohmann::json& json, LiquidityProviderConfig& c) {
    constexpr std::string_view p = "liquidityProviders";
    checkObject(json, p, {"count", "ratePerSecond", "behindTicksMin", "behindTicksMax", "qty",
                          "lifetimeMeanSeconds"});
    readInteger(json, p, "count", 0, kFirstNonSimTraderId - 1, c.count);
    readNumber(json, p, "ratePerSecond", c.ratePerSecond);
    readInteger(json, p, "behindTicksMin", 0, kMaxTicks, c.behindTicksMin);
    readInteger(json, p, "behindTicksMax", 0, kMaxTicks, c.behindTicksMax);
    readQty(json, p, c.qty);
    readNumber(json, p, "lifetimeMeanSeconds", c.lifetimeMeanSeconds);
    requirePositive(c.ratePerSecond, "liquidityProviders.ratePerSecond");
    if (c.behindTicksMax < c.behindTicksMin) {
        fail("liquidityProviders.behindTicksMax", "must be at least behindTicksMin");
    }
    requirePositive(c.lifetimeMeanSeconds, "liquidityProviders.lifetimeMeanSeconds");
}

}  // namespace sim_config_detail

// Validates an already-parsed JSON value. Throws SimConfigError naming the
// first problem found.
inline SimConfig parseSimConfig(const nlohmann::json& json) {
    namespace d = sim_config_detail;
    d::checkObject(json, "", {"fairValue", "marketMakers", "takers", "liquidityProviders"});
    SimConfig config;
    if (const auto it = json.find("fairValue"); it != json.end()) {
        d::parseFairValue(*it, config.fairValue);
    }
    if (const auto it = json.find("marketMakers"); it != json.end()) {
        d::parseMarketMakers(*it, config.marketMakers);
    }
    if (const auto it = json.find("takers"); it != json.end()) d::parseTakers(*it, config.takers);
    if (const auto it = json.find("liquidityProviders"); it != json.end()) {
        d::parseLiquidityProviders(*it, config.liquidityProviders);
    }
    if (config.totalAgents() >= kFirstNonSimTraderId) {
        d::fail("config", "has " + std::to_string(config.totalAgents()) +
                              " agents; simulated trader IDs must stay below " +
                              std::to_string(kFirstNonSimTraderId));
    }
    return config;
}

// Parses and validates JSON text.
inline SimConfig parseSimConfigText(std::string_view text) {
    nlohmann::json json;
    try {
        json = nlohmann::json::parse(text);
    } catch (const nlohmann::json::parse_error& e) {
        throw SimConfigError(std::string("Invalid sim config: malformed JSON: ") + e.what());
    }
    return parseSimConfig(json);
}

// Reads and validates a sim config file.
inline SimConfig loadSimConfig(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw SimConfigError("Cannot open sim config: " + path.string());
    std::ostringstream contents;
    contents << in.rdbuf();
    try {
        return parseSimConfigText(contents.str());
    } catch (const SimConfigError& e) {
        throw SimConfigError(path.string() + ": " + e.what());
    }
}

}  // namespace engine_service

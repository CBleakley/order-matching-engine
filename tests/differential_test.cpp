#include <gtest/gtest.h>

#include <cstdint>
#include <string>

#include "DifferentialHarness.h"

// Differential tests: random order flow is fed to both the real engine and the
// naive ReferenceOrderBook, and their event streams must match exactly.
//
// To rerun one seed (e.g. from a failure report), set DIFF_SEED:
//   DIFF_SEED=42 tests --gtest_filter=Differential.DefaultFlow

namespace engine {
namespace {

// Runs seeds [1, seeds] (or just DIFF_SEED, if set) with `config`.
void runSeeds(const char* testName, std::uint64_t seeds, const flow::OrderFlowConfig& config) {
    const auto only  = seedOverride();
    const auto first = only.value_or(1);
    const auto last  = only.value_or(seeds);

    for (std::uint64_t seed = first; seed <= last; ++seed) {
        const std::string hint = "  rerun with: DIFF_SEED=" + std::to_string(seed) +
                                 " tests --gtest_filter=Differential." + testName;
        if (const auto failure = runDifferential(seed, config, hint)) {
            FAIL() << *failure;
        }
    }
}

TEST(Differential, DefaultFlow) {
    runSeeds("DefaultFlow", 100, flow::OrderFlowConfig{});
}

TEST(Differential, HeavyCancels) {
    flow::OrderFlowConfig config;
    config.cancelProbability = 0.6;
    runSeeds("HeavyCancels", 25, config);
}

TEST(Differential, TightSpreadLargeOrders) {
    // Few price levels with deep queues, and large orders that sweep them.
    flow::OrderFlowConfig config;
    config.priceSpread = 3;
    config.maxQty      = 500;
    runSeeds("TightSpreadLargeOrders", 25, config);
}

TEST(Differential, WideSpreadFewTraders) {
    // A deeper book with many levels, mostly resting rather than trading.
    flow::OrderFlowConfig config;
    config.priceSpread       = 200;
    config.traders           = 2;
    config.cancelProbability = 0.2;
    runSeeds("WideSpreadFewTraders", 10, config);
}

}  // namespace
}  // namespace engine

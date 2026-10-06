#include <gtest/gtest.h>

#include <cstdint>
#include <string>

#include "DifferentialHarness.h"

// Long-running differential tests (CTest label `slow`, excluded from the
// default test presets; run with `ctest --preset slow`). Together they run
// several million operations.
//
// To rerun one seed: DIFF_SEED=42 slow_tests --gtest_filter=DifferentialSlow.ManySeeds

namespace engine {
namespace {

TEST(DifferentialSlow, ManySeeds) {
    flow::OrderFlowConfig config;
    config.operations = 100'000;

    const auto only = seedOverride();
    for (std::uint64_t seed = only.value_or(1001); seed <= only.value_or(1050); ++seed) {
        const std::string hint = "  rerun with: DIFF_SEED=" + std::to_string(seed) +
                                 " slow_tests --gtest_filter=DifferentialSlow.ManySeeds";
        if (const auto failure = runDifferential(seed, config, hint)) FAIL() << *failure;
    }
}

TEST(DifferentialSlow, LongRun) {
    // One long history, so IDs, sequence numbers and the book grow large.
    flow::OrderFlowConfig config;
    config.operations = 1'000'000;

    const std::uint64_t seed = seedOverride().value_or(2001);
    const std::string hint = "  rerun with: DIFF_SEED=" + std::to_string(seed) +
                             " slow_tests --gtest_filter=DifferentialSlow.LongRun";
    if (const auto failure = runDifferential(seed, config, hint)) FAIL() << *failure;
}

}  // namespace
}  // namespace engine

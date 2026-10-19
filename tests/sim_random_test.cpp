#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>

#include "SimRandom.h"

namespace {

using engine_service::SimRandom;

TEST(SimRandom, SameSeedSameStream) {
    SimRandom a(42);
    SimRandom b(42);
    for (int i = 0; i < 1000; ++i) {
        ASSERT_EQ(a.uniform01(), b.uniform01());
        ASSERT_EQ(a.normal(), b.normal());
        ASSERT_EQ(a.exponential(3.0), b.exponential(3.0));
        ASSERT_EQ(a.uniformInt(-5, 5), b.uniformInt(-5, 5));
    }
}

TEST(SimRandom, DifferentSeedsDiffer) {
    SimRandom a(1);
    SimRandom b(2);
    int       same = 0;
    for (int i = 0; i < 100; ++i) same += a.uniform01() == b.uniform01() ? 1 : 0;
    EXPECT_LT(same, 5);
}

TEST(SimRandom, UniformRanges) {
    SimRandom random(7);
    bool      sawLo = false;
    bool      sawHi = false;
    for (int i = 0; i < 10'000; ++i) {
        const double u = random.uniform01();
        ASSERT_GE(u, 0.0);
        ASSERT_LT(u, 1.0);
        const std::int64_t n = random.uniformInt(-3, 3);
        ASSERT_GE(n, -3);
        ASSERT_LE(n, 3);
        sawLo = sawLo || n == -3;
        sawHi = sawHi || n == 3;
    }
    EXPECT_TRUE(sawLo);
    EXPECT_TRUE(sawHi);
    EXPECT_EQ(random.uniformInt(4, 4), 4);
}

// Loose bounds: these check the samplers are the right shape, not exact values.
TEST(SimRandom, NormalHasMeanZeroAndUnitVariance) {
    SimRandom    random(11);
    constexpr int kN = 200'000;
    double       sum = 0.0;
    double       sumSq = 0.0;
    for (int i = 0; i < kN; ++i) {
        const double x = random.normal();
        ASSERT_TRUE(std::isfinite(x));
        sum += x;
        sumSq += x * x;
    }
    const double mean = sum / kN;
    EXPECT_NEAR(mean, 0.0, 0.02);
    EXPECT_NEAR(sumSq / kN - mean * mean, 1.0, 0.02);
}

TEST(SimRandom, ExponentialHasTheGivenMean) {
    SimRandom    random(13);
    constexpr int kN = 200'000;
    double       sum = 0.0;
    for (int i = 0; i < kN; ++i) {
        const double x = random.exponential(0.5);
        ASSERT_GE(x, 0.0);
        ASSERT_TRUE(std::isfinite(x));
        sum += x;
    }
    EXPECT_NEAR(sum / kN, 0.5, 0.01);
}

TEST(SimRandom, ChanceMatchesItsProbability) {
    SimRandom    random(17);
    constexpr int kN = 100'000;
    int          hits = 0;
    for (int i = 0; i < kN; ++i) hits += random.chance(0.3) ? 1 : 0;
    EXPECT_NEAR(static_cast<double>(hits) / kN, 0.3, 0.01);
    EXPECT_FALSE(random.chance(0.0));
    EXPECT_TRUE(random.chance(1.0));
}

}  // namespace

#pragma once

#include <cmath>
#include <cstdint>
#include <numbers>
#include <random>

// Seeded randomness for the market simulator. Only std::mt19937_64 is used,
// whose output is fully specified, and never the standard distributions, whose
// output is not; the samplers below are written out by hand so that the same
// seed gives the same simulation on every platform (as RandomOrderFlow does).

namespace engine_service {

class SimRandom {
public:
    explicit SimRandom(std::uint64_t seed) : rng_(seed) {}

    // Uniform in [0, 1), with 53 bits of precision.
    double uniform01() {
        constexpr double kScale = 1.0 / 9007199254740992.0;  // 2^-53
        return static_cast<double>(rng_() >> 11) * kScale;
    }

    // Uniform integer in [lo, hi]. The modulo bias is negligible for the small
    // ranges the simulator uses.
    std::int64_t uniformInt(std::int64_t lo, std::int64_t hi) {
        const auto span = static_cast<std::uint64_t>(hi - lo) + 1;
        return lo + static_cast<std::int64_t>(rng_() % span);
    }

    // Uniform in [lo, hi).
    double uniform(double lo, double hi) { return lo + (hi - lo) * uniform01(); }

    // True with probability p.
    bool chance(double p) { return uniform01() < p; }

    // Standard normal, by Box-Muller. Each call draws two uniforms and uses
    // one result, so the stream does not depend on a cached second value.
    double normal() {
        const double u1 = 1.0 - uniform01();  // (0, 1], so the log is finite
        const double u2 = uniform01();
        return std::sqrt(-2.0 * std::log(u1)) * std::cos(2.0 * std::numbers::pi * u2);
    }

    // Exponential with the given mean: the gap between Poisson arrivals at
    // rate 1 / mean.
    double exponential(double mean) { return -mean * std::log(1.0 - uniform01()); }

private:
    std::mt19937_64 rng_;
};

}  // namespace engine_service

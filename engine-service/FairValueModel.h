#pragma once

#include <algorithm>
#include <cmath>

#include "SimConfig.h"
#include "SimRandom.h"
#include "Types.h"

// The simulator's notion of what the instrument is worth: a random walk with
// clustered volatility, a slowly decaying trend and a weak pull back to an
// anchor (see FairValueConfig for the equations). One step() is one simulated
// second.
//
// The price is held as a double in tick units. Every term works on ratios
// (log returns, ln(anchor / p)), so this is the same process as working in
// decimal; ticks() rounds to the nearest tick.

namespace engine_service {

class FairValueModel {
public:
    FairValueModel(const FairValueConfig& config, engine::Price anchorTicks)
        : config_(config), anchor_(static_cast<double>(anchorTicks)),
          price_(static_cast<double>(anchorTicks)), vol_(config.initialVol) {}

    void step(SimRandom& random) {
        vol_   = std::clamp(vol_ * std::exp(config_.volOfVol * random.normal()), config_.volMin,
                            config_.volMax);
        trend_ = config_.trendDecay * trend_ + config_.trendScale * vol_ * random.normal();
        const double pull = config_.meanReversion * std::log(anchor_ / price_);
        price_ *= std::exp(vol_ * random.normal() + trend_ + pull);
    }

    double price() const noexcept { return price_; }
    double vol() const noexcept { return vol_; }

    // The price rounded to the nearest tick, kept within [minTicks, maxTicks].
    engine::Price ticks(engine::Price minTicks, engine::Price maxTicks) const {
        const double clamped =
            std::clamp(price_, static_cast<double>(minTicks), static_cast<double>(maxTicks));
        return static_cast<engine::Price>(std::llround(clamped));
    }

private:
    FairValueConfig config_;
    double          anchor_;
    double          price_;
    double          vol_;
    double          trend_ = 0.0;
};

}  // namespace engine_service

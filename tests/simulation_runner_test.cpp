#include <gtest/gtest.h>

#include <chrono>
#include <variant>
#include <vector>

#include <asio.hpp>

#include "Clock.h"
#include "EngineCore.h"
#include "Instrument.h"
#include "InternalProtocol.h"
#include "SimConfig.h"
#include "SimulationRunner.h"
#include "Simulator.h"

// The live simulation on a real io_context and the system clock.

namespace {

namespace wire = engine_service::protocol;
using namespace std::chrono_literals;

struct RecordingOutput final : engine_service::EventOutput {
    std::vector<wire::EngineMessage> messages;
    void send(const wire::EngineMessage& message) override { messages.push_back(message); }
};

TEST(LiveSimulation, RunsActionsOnTheWallClockUntilStopped) {
    const engine_service::InstrumentConfig instrument{.symbol              = "NOVA",
                                                      .name                = "Nova Dynamics",
                                                      .tickSize            = "0.01",
                                                      .priceDecimals       = 2,
                                                      .minPriceTicks       = 1,
                                                      .maxPriceTicks       = 100'000'000,
                                                      .maxOrderQty         = 10'000,
                                                      .referencePriceTicks = 14'250};
    engine_service::SystemClock clock;
    engine_service::EngineCore  core(
        clock, engine_service::CoreConfig::forInstrument(instrument, std::chrono::hours(1)));
    engine_service::Simulator simulator(core, engine_service::SimConfig{}, instrument, 1);
    RecordingOutput           gateway;
    core.setObserver(&simulator);
    core.setOutput(&gateway);

    asio::io_context                io;
    engine_service::LiveSimulation live(io, simulator, clock);
    const wire::Timestamp           started = clock.now();
    simulator.start(started);
    live.start();

    asio::steady_timer stopper(io, 300ms);
    stopper.async_wait([&](std::error_code) { live.stop(); });
    io.run();  // returns only once the simulation has stopped

    // The market makers quote at the start time, so events are certain.
    bool rested = false;
    for (const wire::EngineMessage& message : gateway.messages) {
        if (const auto* r = std::get_if<wire::OrderRested>(&message)) {
            rested = true;
            EXPECT_GE(r->ts, started);
            EXPECT_LE(r->ts, clock.now());
        }
    }
    EXPECT_TRUE(rested);
    EXPECT_TRUE(core.book().bestBid().has_value());
    EXPECT_TRUE(core.book().bestAsk().has_value());
    EXPECT_GT(simulator.nextActionTime(), started);
}

}  // namespace

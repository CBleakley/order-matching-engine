// Engine service entry point: hosts the order book on one thread and serves
// one gateway over TCP using the internal protocol.
#include <chrono>
#include <csignal>
#include <cstdint>
#include <exception>
#include <iostream>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <asio.hpp>

#include "Clock.h"
#include "EngineCore.h"
#include "Instrument.h"
#include "Logger.h"
#include "Options.h"
#include "Price.h"
#include "SimConfig.h"
#include "SimulationRunner.h"
#include "Simulator.h"
#include "TcpServer.h"

namespace {

using namespace engine_service;

// A fresh random value per process start: the engine instance ID (so the
// gateway can tell a restarted engine service, whose order IDs and eventSeq
// start again, from a reconnect) and the default simulator seed.
std::uint64_t random64() {
    std::random_device device;
    return (static_cast<std::uint64_t>(device()) << 32) ^ device();
}

}  // namespace

int main(int argc, char* argv[]) {
    const std::vector<std::string_view> args(argv + 1, argv + argc);
    const auto parsed = parseOptions(args);
    if (const auto* error = std::get_if<std::string>(&parsed)) {
        std::cerr << "engine_service: " << *error << '\n' << kUsage;
        return 2;
    }
    const Options& options = std::get<Options>(parsed);
    if (options.help) {
        std::cout << kUsage;
        return 0;
    }

    Logger log(options.logLevel, std::cerr);
    try {
        const InstrumentConfig instrument = loadInstrumentConfig(options.instrument);
        log.info("instrument " + instrument.symbol + " (" + instrument.name + "), tick " +
                 instrument.tickSize + ", reference price " +
                 ticksToDecimalString(instrument.referencePriceTicks, instrument));

        log.info("retaining trades for " + std::to_string(options.retention.count()) +
                 " s for the reconnect snapshot");

        ServerConfig config;
        config.address          = options.bind;
        config.port             = options.port;
        config.engineInstanceId = random64();

        asio::io_context io;
        SystemClock      wall;
        SwitchableClock  clock(wall);
        EngineCore       core(clock, CoreConfig::forInstrument(instrument, options.retention));

        // The simulator warms up before the server starts listening, so a
        // gateway only ever connects to a market that already has history.
        std::optional<Simulator>      simulator;
        std::optional<LiveSimulation> live;
        if (options.noSim) {
            log.info("market simulator disabled");
        } else {
            const SimConfig simConfig =
                options.simConfig ? loadSimConfig(*options.simConfig) : SimConfig{};
            const std::uint64_t seed = options.seed ? *options.seed : random64();
            simulator.emplace(core, simConfig, instrument, seed);
            core.setObserver(&*simulator);

            log.info("market simulator: " + std::to_string(simulator->agentCount()) +
                     " agents, seed " + std::to_string(seed) + "; warming up " +
                     std::to_string(options.warmup.count()) + " s of history");
            const auto started = std::chrono::steady_clock::now();
            const std::int64_t warmupNs =
                std::chrono::duration_cast<std::chrono::nanoseconds>(options.warmup).count();
            warmUp(*simulator, clock, wall.now() - warmupNs);
            const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                       std::chrono::steady_clock::now() - started)
                                       .count();
            log.info("warm-up done in " + std::to_string(elapsedMs) + " ms: " +
                     std::to_string(simulator->stats().trades) + " trades, " +
                     std::to_string(core.retainedTradeCount()) + " retained, " +
                     std::to_string(core.book().orderCount()) + " resting orders");
            live.emplace(io, *simulator, clock);
        }

        TcpServer server(io, core, clock, log, config);
        server.start();
        if (live) live->start();

        asio::signal_set signals(io, SIGINT, SIGTERM);
        signals.async_wait([&](std::error_code ec, int signal) {
            if (ec) return;
            log.info("received signal " + std::to_string(signal) + ", shutting down");
            server.stop();
            if (live) live->stop();
        });

        io.run();
        log.info("stopped");
    } catch (const std::exception& e) {
        log.error(e.what());
        return 1;
    }
    return 0;
}

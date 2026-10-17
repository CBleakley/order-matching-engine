// Engine service entry point: hosts the order book on one thread and serves
// one gateway over TCP using the internal protocol.
#include <csignal>
#include <cstdint>
#include <exception>
#include <iostream>
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
#include "TcpServer.h"

namespace {

using namespace engine_service;

// Random per process start, so the gateway can tell a restarted engine
// service (whose order IDs and eventSeq start again) from a reconnect.
std::uint64_t randomInstanceId() {
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

        ServerConfig config;
        config.address          = options.bind;
        config.port             = options.port;
        config.engineInstanceId = randomInstanceId();

        asio::io_context io;
        SystemClock      clock;
        EngineCore       core(clock);
        TcpServer        server(io, core, clock, log, config);
        server.start();

        asio::signal_set signals(io, SIGINT, SIGTERM);
        signals.async_wait([&](std::error_code ec, int signal) {
            if (ec) return;
            log.info("received signal " + std::to_string(signal) + ", shutting down");
            server.stop();
        });

        io.run();
        log.info("stopped");
    } catch (const std::exception& e) {
        log.error(e.what());
        return 1;
    }
    return 0;
}

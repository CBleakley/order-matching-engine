#pragma once

#include <charconv>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <variant>

#include "Logger.h"

// Command-line options for the engine_service executable.

namespace engine_service {

struct Options {
    std::string           bind       = "127.0.0.1";
    std::uint16_t         port       = 7001;
    std::filesystem::path instrument = "protocol/instrument.json";
    LogLevel              logLevel   = LogLevel::Info;
    std::chrono::seconds  retention  = std::chrono::hours(24);
    // The market simulator.
    std::optional<std::filesystem::path> simConfig;  // built-in defaults if not given
    std::optional<std::uint64_t>         seed;       // random if not given
    std::chrono::seconds                 warmup = std::chrono::hours(6);
    bool                                 noSim  = false;
    bool                                 help   = false;
};

constexpr std::string_view kUsage =
    "usage: engine_service [options]\n"
    "  --bind <address>     address to listen on (default 127.0.0.1)\n"
    "  --port <port>        port to listen on (default 7001; 0 picks a free port)\n"
    "  --instrument <path>  instrument config (default protocol/instrument.json)\n"
    "  --log-level <level>  error, warn, info or debug (default info)\n"
    "  --retention <time>   how long to keep trades for the reconnect snapshot:\n"
    "                       a positive number then s, m or h (default 24h)\n"
    "  --sim-config <path>  market simulator config (JSON; default: built-in values)\n"
    "  --seed <n>           simulator random seed (default: random, and logged)\n"
    "  --warmup <time>      simulated history to backfill at boot, e.g. 6h or 0s\n"
    "                       (default 6h)\n"
    "  --no-sim             run without simulated traders\n"
    "  --help               show this message\n";

// Parses a duration such as "30s", "90m" or "24h": a positive integer and a
// unit. Returns nullopt if it is malformed, would overflow, or is zero (unless
// allowZero).
inline std::optional<std::chrono::seconds> parseDuration(std::string_view text,
                                                         bool allowZero = false) {
    if (text.size() < 2) return std::nullopt;
    std::int64_t unitSeconds = 0;
    switch (text.back()) {
        case 's': unitSeconds = 1; break;
        case 'm': unitSeconds = 60; break;
        case 'h': unitSeconds = 3600; break;
        default: return std::nullopt;
    }
    const std::string_view digits = text.substr(0, text.size() - 1);
    std::int64_t           count  = 0;
    const auto [end, ec] = std::from_chars(digits.data(), digits.data() + digits.size(), count);
    if (ec != std::errc{} || end != digits.data() + digits.size() || count < (allowZero ? 0 : 1)) {
        return std::nullopt;
    }
    // Stay well inside what nanosecond timestamps can represent (~292 years).
    constexpr std::int64_t kMaxSeconds = std::int64_t{100} * 365 * 24 * 3600;
    if (count > kMaxSeconds / unitSeconds) return std::nullopt;
    return std::chrono::seconds(count * unitSeconds);
}

// Parses the arguments after the program name. Returns the options, or an
// error message suitable for printing above the usage text.
inline std::variant<Options, std::string> parseOptions(std::span<const std::string_view> args) {
    Options options;
    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string_view arg = args[i];
        if (arg == "--help" || arg == "-h") {
            options.help = true;
            continue;
        }
        if (arg == "--no-sim") {
            options.noSim = true;
            continue;
        }
        if (arg != "--bind" && arg != "--port" && arg != "--instrument" && arg != "--log-level" &&
            arg != "--retention" && arg != "--sim-config" && arg != "--seed" && arg != "--warmup") {
            return "unknown option '" + std::string(arg) + "'";
        }
        if (i + 1 >= args.size()) return "missing value for " + std::string(arg);
        const std::string_view value = args[++i];

        if (arg == "--bind") {
            if (value.empty()) return std::string("--bind needs an address");
            options.bind = std::string(value);
        } else if (arg == "--port") {
            unsigned port = 0;
            const auto [end, ec] = std::from_chars(value.data(), value.data() + value.size(), port);
            if (ec != std::errc{} || end != value.data() + value.size() || port > 65535) {
                return "invalid port '" + std::string(value) + "'";
            }
            options.port = static_cast<std::uint16_t>(port);
        } else if (arg == "--instrument") {
            options.instrument = std::filesystem::path(value);
        } else if (arg == "--retention") {
            const auto retention = parseDuration(value);
            if (!retention) return "invalid retention '" + std::string(value) + "'";
            options.retention = *retention;
        } else if (arg == "--sim-config") {
            options.simConfig = std::filesystem::path(value);
        } else if (arg == "--seed") {
            std::uint64_t seed = 0;
            const auto [end, ec] = std::from_chars(value.data(), value.data() + value.size(), seed);
            if (ec != std::errc{} || end != value.data() + value.size()) {
                return "invalid seed '" + std::string(value) + "'";
            }
            options.seed = seed;
        } else if (arg == "--warmup") {
            const auto warmup = parseDuration(value, /*allowZero=*/true);
            if (!warmup) return "invalid warmup '" + std::string(value) + "'";
            options.warmup = *warmup;
        } else {
            const auto level = parseLogLevel(value);
            if (!level) return "invalid log level '" + std::string(value) + "'";
            options.logLevel = *level;
        }
    }
    return options;
}

}  // namespace engine_service

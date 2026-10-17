#pragma once

#include <charconv>
#include <cstdint>
#include <filesystem>
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
    bool                  help       = false;
};

constexpr std::string_view kUsage =
    "usage: engine_service [options]\n"
    "  --bind <address>     address to listen on (default 127.0.0.1)\n"
    "  --port <port>        port to listen on (default 7001; 0 picks a free port)\n"
    "  --instrument <path>  instrument config (default protocol/instrument.json)\n"
    "  --log-level <level>  error, warn, info or debug (default info)\n"
    "  --help               show this message\n";

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
        if (arg != "--bind" && arg != "--port" && arg != "--instrument" && arg != "--log-level") {
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
        } else {
            const auto level = parseLogLevel(value);
            if (!level) return "invalid log level '" + std::string(value) + "'";
            options.logLevel = *level;
        }
    }
    return options;
}

}  // namespace engine_service

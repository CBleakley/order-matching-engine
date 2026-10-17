#pragma once

#include <chrono>
#include <cstdint>
#include <ctime>
#include <iomanip>
#include <optional>
#include <ostream>
#include <string_view>

// Minimal line logger for the engine service. It logs events of interest
// (connections, protocol errors), never individual orders.

namespace engine_service {

enum class LogLevel : std::uint8_t { Error, Warn, Info, Debug };

constexpr std::string_view toString(LogLevel level) noexcept {
    switch (level) {
        case LogLevel::Error: return "error";
        case LogLevel::Warn:  return "warn";
        case LogLevel::Info:  return "info";
        case LogLevel::Debug: return "debug";
    }
    return "unknown";
}

inline std::optional<LogLevel> parseLogLevel(std::string_view text) {
    for (const LogLevel level : {LogLevel::Error, LogLevel::Warn, LogLevel::Info, LogLevel::Debug}) {
        if (text == toString(level)) return level;
    }
    return std::nullopt;
}

class Logger {
public:
    Logger(LogLevel level, std::ostream& out) : level_(level), out_(out) {}

    bool enabled(LogLevel level) const noexcept { return level <= level_; }

    void log(LogLevel level, std::string_view message) {
        if (!enabled(level)) return;
        writeTimestamp(out_);
        out_ << ' ' << toString(level) << ' ' << message << '\n';
        out_.flush();
    }

    void error(std::string_view message) { log(LogLevel::Error, message); }
    void warn(std::string_view message) { log(LogLevel::Warn, message); }
    void info(std::string_view message) { log(LogLevel::Info, message); }
    void debug(std::string_view message) { log(LogLevel::Debug, message); }

private:
    // UTC wall-clock time with milliseconds, e.g. 2026-10-17T16:40:08.123Z.
    static void writeTimestamp(std::ostream& os) {
        const auto now = std::chrono::system_clock::now();
        const auto ms =
            std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) % 1000;
        const std::time_t seconds = std::chrono::system_clock::to_time_t(now);
        std::tm utc{};
#ifdef _WIN32
        gmtime_s(&utc, &seconds);
#else
        gmtime_r(&seconds, &utc);
#endif
        os << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setw(3) << std::setfill('0')
           << ms.count() << std::setfill(' ') << 'Z';
    }

    LogLevel      level_;
    std::ostream& out_;
};

}  // namespace engine_service

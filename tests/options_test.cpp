#include <gtest/gtest.h>

#include <chrono>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "Options.h"

namespace {

using engine_service::LogLevel;
using engine_service::Options;
using engine_service::parseOptions;

std::variant<Options, std::string> parse(std::vector<std::string_view> args) {
    return parseOptions(args);
}

TEST(Options, Defaults) {
    const auto result = parse({});
    ASSERT_TRUE(std::holds_alternative<Options>(result));
    const Options& options = std::get<Options>(result);
    EXPECT_EQ(options.bind, "127.0.0.1");
    EXPECT_EQ(options.port, 7001);
    EXPECT_EQ(options.instrument, "protocol/instrument.json");
    EXPECT_EQ(options.logLevel, LogLevel::Info);
    EXPECT_EQ(options.retention, std::chrono::hours(24));
    EXPECT_FALSE(options.help);
}

TEST(Options, Retention) {
    EXPECT_EQ(std::get<Options>(parse({"--retention", "30s"})).retention, std::chrono::seconds(30));
    EXPECT_EQ(std::get<Options>(parse({"--retention", "90m"})).retention, std::chrono::minutes(90));
    EXPECT_EQ(std::get<Options>(parse({"--retention", "1h"})).retention, std::chrono::hours(1));
    EXPECT_EQ(std::get<Options>(parse({"--retention", "48h"})).retention, std::chrono::hours(48));
}

TEST(Options, EveryFlag) {
    const auto result = parse({"--bind", "0.0.0.0", "--port", "9000", "--instrument",
                               "/etc/nova.json", "--log-level", "debug"});
    ASSERT_TRUE(std::holds_alternative<Options>(result));
    const Options& options = std::get<Options>(result);
    EXPECT_EQ(options.bind, "0.0.0.0");
    EXPECT_EQ(options.port, 9000);
    EXPECT_EQ(options.instrument, "/etc/nova.json");
    EXPECT_EQ(options.logLevel, LogLevel::Debug);
}

TEST(Options, PortBoundaries) {
    EXPECT_EQ(std::get<Options>(parse({"--port", "0"})).port, 0);
    EXPECT_EQ(std::get<Options>(parse({"--port", "65535"})).port, 65535);
}

TEST(Options, Help) {
    EXPECT_TRUE(std::get<Options>(parse({"--help"})).help);
    EXPECT_TRUE(std::get<Options>(parse({"-h"})).help);
}

TEST(Options, Errors) {
    const std::vector<std::vector<std::string_view>> cases = {
        {"--port"},
        {"--port", "65536"},
        {"--port", "-1"},
        {"--port", "80x"},
        {"--port", ""},
        {"--bind", ""},
        {"--log-level", "verbose"},
        {"--retention"},
        {"--retention", ""},
        {"--retention", "24"},
        {"--retention", "h"},
        {"--retention", "0h"},
        {"--retention", "-1h"},
        {"--retention", "+1h"},
        {"--retention", "1d"},
        {"--retention", "1.5h"},
        {"--retention", "99999999999h"},
        {"--threads", "4"},
        {"7001"},
    };
    for (const auto& args : cases) {
        EXPECT_TRUE(std::holds_alternative<std::string>(parse(args))) << args.front();
    }
}

}  // namespace

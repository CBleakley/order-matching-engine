#include <gtest/gtest.h>

#include <cstdint>
#include <limits>
#include <string>
#include <variant>

#include <nlohmann/json.hpp>

#include "Instrument.h"
#include "Price.h"
#include "ProtocolFixtures.h"

namespace {

using engine_service::InstrumentConfig;
using engine_service::parseDecimalToTicks;
using engine_service::PriceParseError;
using engine_service::ticksToDecimalString;
using nlohmann::json;

InstrumentConfig nova() {
    return engine_service::loadInstrumentConfig(protocol_fixtures::kProtocolDir /
                                                "instrument.json");
}

// Renders a parse result the way the fixture spells it: the tick count, or the error code.
std::string describe(const engine_service::PriceParseResult& result) {
    if (const auto* ticks = std::get_if<engine::Price>(&result)) return std::to_string(*ticks);
    return std::string(toString(std::get<PriceParseError>(result)));
}

TEST(PriceFixture, MatchesEveryGroup) {
    const json fixture = protocol_fixtures::readJson("fixtures/prices.json");
    ASSERT_FALSE(fixture.at("groups").empty());
    for (const json& group : fixture.at("groups")) {
        SCOPED_TRACE(group.at("name").get<std::string>());
        InstrumentConfig config = nova();
        config.priceDecimals = group.at("config").at("priceDecimals").get<int>();
        config.minPriceTicks = group.at("config").at("minPriceTicks").get<engine::Price>();
        config.maxPriceTicks = group.at("config").at("maxPriceTicks").get<engine::Price>();

        for (const json& c : group.at("roundTrip")) {
            const auto decimal = c.at("decimal").get<std::string>();
            const auto ticks = c.at("ticks").get<engine::Price>();
            EXPECT_EQ(describe(parseDecimalToTicks(decimal, config)), std::to_string(ticks))
                << "parse \"" << decimal << '"';
            EXPECT_EQ(ticksToDecimalString(ticks, config), decimal) << "format " << ticks;
        }
        for (const json& c : group.at("parse")) {
            const auto input = c.at("input").get<std::string>();
            EXPECT_EQ(describe(parseDecimalToTicks(input, config)),
                      std::to_string(c.at("ticks").get<engine::Price>()))
                << "parse \"" << input << '"';
        }
        for (const json& c : group.at("invalid")) {
            const auto input = c.at("input").get<std::string>();
            EXPECT_EQ(describe(parseDecimalToTicks(input, config)),
                      c.at("error").get<std::string>())
                << "parse \"" << input << '"';
        }
    }
}

TEST(Price, ErrorCodes) {
    EXPECT_EQ(toString(PriceParseError::Empty), "empty");
    EXPECT_EQ(toString(PriceParseError::InvalidFormat), "invalid-format");
    EXPECT_EQ(toString(PriceParseError::TooManyDecimals), "too-many-decimals");
    EXPECT_EQ(toString(PriceParseError::OutOfRange), "out-of-range");
}

TEST(Price, RejectsEmbeddedNul) {
    using namespace std::string_literals;
    EXPECT_EQ(describe(parseDecimalToTicks("1\0"s, nova())), "invalid-format");
}

TEST(Price, FormatsAnyInt64) {
    const InstrumentConfig config = nova();
    EXPECT_EQ(ticksToDecimalString(0, config), "0.00");
    EXPECT_EQ(ticksToDecimalString(5, config), "0.05");
    EXPECT_EQ(ticksToDecimalString(-5, config), "-0.05");
    EXPECT_EQ(ticksToDecimalString(-14'250, config), "-142.50");
    EXPECT_EQ(ticksToDecimalString(std::numeric_limits<std::int64_t>::max(), config),
              "92233720368547758.07");
    EXPECT_EQ(ticksToDecimalString(std::numeric_limits<std::int64_t>::min(), config),
              "-92233720368547758.08");
}

}  // namespace

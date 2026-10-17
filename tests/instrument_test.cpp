#include <gtest/gtest.h>

#include <filesystem>
#include <string>

#include <nlohmann/json.hpp>

#include "Instrument.h"
#include "ProtocolFixtures.h"

namespace {

using engine_service::InstrumentConfig;
using engine_service::InstrumentConfigError;
using engine_service::loadInstrumentConfig;
using engine_service::parseInstrumentConfig;
using engine_service::parseInstrumentConfigText;
using nlohmann::json;

json checkedInConfig() {
    return protocol_fixtures::readJson("instrument.json");
}

TEST(InstrumentConfig, LoadsTheCheckedInFile) {
    const InstrumentConfig config =
        loadInstrumentConfig(protocol_fixtures::kProtocolDir / "instrument.json");
    EXPECT_EQ(config.symbol, "NOVA");
    EXPECT_EQ(config.name, "Nova Dynamics");
    EXPECT_EQ(config.tickSize, "0.01");
    EXPECT_EQ(config.priceDecimals, 2);
    EXPECT_EQ(config.minPriceTicks, 1);
    EXPECT_EQ(config.maxPriceTicks, 100'000'000);
    EXPECT_EQ(config.maxOrderQty, 10'000);
    EXPECT_EQ(config.referencePriceTicks, 14'250);
}

TEST(InstrumentConfig, AcceptsValidVariations) {
    const struct {
        const char* name;
        json        overrides;
    } cases[] = {
        {"whole-unit ticks", {{"priceDecimals", 0}, {"tickSize", "1"}}},
        {"8 decimals", {{"priceDecimals", 8}, {"tickSize", "0.00000001"}}},
        {"a single valid price",
         {{"minPriceTicks", 5}, {"maxPriceTicks", 5}, {"referencePriceTicks", 5}}},
        {"notional exactly 2^53 - 1",
         {{"maxPriceTicks", engine_service::kMaxSafeInteger}, {"maxOrderQty", 1}}},
    };
    for (const auto& c : cases) {
        json config = checkedInConfig();
        config.update(c.overrides);
        EXPECT_NO_THROW(parseInstrumentConfig(config)) << c.name;
    }
}

TEST(InstrumentConfig, RejectsEverySharedInvalidFixture) {
    const json fixture = protocol_fixtures::readJson("fixtures/instrument-configs.json");
    ASSERT_FALSE(fixture.at("invalid").empty());
    for (const json& c : fixture.at("invalid")) {
        EXPECT_THROW(parseInstrumentConfig(c.at("config")), InstrumentConfigError)
            << c.at("description").get<std::string>();
    }
}

// JavaScript cannot tell 1.0 from 1, so these are not in the shared fixture,
// but the C++ loader rejects them.
TEST(InstrumentConfig, RejectsIntegralFloats) {
    json config = checkedInConfig();
    config["maxOrderQty"] = 10000.0;
    EXPECT_THROW(parseInstrumentConfig(config), InstrumentConfigError);
}

TEST(InstrumentConfig, RejectsMalformedJsonText) {
    EXPECT_THROW(parseInstrumentConfigText(""), InstrumentConfigError);
    EXPECT_THROW(parseInstrumentConfigText("{\"symbol\": \"NOVA\","), InstrumentConfigError);
}

TEST(InstrumentConfig, ErrorNamesTheOffendingField) {
    json config = checkedInConfig();
    config["tickSize"] = "0.1";
    try {
        parseInstrumentConfig(config);
        FAIL() << "expected InstrumentConfigError";
    } catch (const InstrumentConfigError& e) {
        EXPECT_NE(std::string(e.what()).find("tickSize"), std::string::npos) << e.what();
    }
}

TEST(InstrumentConfig, MissingFileThrowsWithThePath) {
    const std::filesystem::path missing = protocol_fixtures::kProtocolDir / "no-such-file.json";
    try {
        loadInstrumentConfig(missing);
        FAIL() << "expected InstrumentConfigError";
    } catch (const InstrumentConfigError& e) {
        EXPECT_NE(std::string(e.what()).find("no-such-file.json"), std::string::npos)
            << e.what();
    }
}

TEST(InstrumentConfig, TickSizeForDecimals) {
    EXPECT_EQ(engine_service::tickSizeForDecimals(0), "1");
    EXPECT_EQ(engine_service::tickSizeForDecimals(1), "0.1");
    EXPECT_EQ(engine_service::tickSizeForDecimals(2), "0.01");
    EXPECT_EQ(engine_service::tickSizeForDecimals(8), "0.00000001");
}

}  // namespace

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "SimConfig.h"

namespace {

using engine_service::loadSimConfig;
using engine_service::parseSimConfigText;
using engine_service::SimConfig;
using engine_service::SimConfigError;

TEST(SimConfig, EmptyObjectGivesTheDefaults) {
    EXPECT_EQ(parseSimConfigText("{}"), SimConfig{});
}

TEST(SimConfig, ShippedFileListsExactlyTheDefaults) {
    EXPECT_EQ(loadSimConfig(ENGINE_SERVICE_DIR "/sim-config.json"), SimConfig{});
}

TEST(SimConfig, DefaultTraderIdsStayBelow1000) {
    EXPECT_LT(SimConfig{}.totalAgents(), engine_service::kFirstNonSimTraderId);
}

TEST(SimConfig, OverridesOnlyTheGivenKeys) {
    const SimConfig config = parseSimConfigText(R"({
        "takers": {"ratePerSecond": 5, "qty": {"min": 2, "max": 20, "mean": 4.5}},
        "marketMakers": {"count": 2},
        "fairValue": {"meanReversion": 0.001}
    })");
    EXPECT_EQ(config.takers.ratePerSecond, 5.0);
    EXPECT_EQ(config.takers.qty.min, 2);
    EXPECT_EQ(config.takers.qty.max, 20);
    EXPECT_EQ(config.takers.qty.mean, 4.5);
    EXPECT_EQ(config.takers.count, SimConfig{}.takers.count);
    EXPECT_EQ(config.marketMakers.count, 2u);
    EXPECT_EQ(config.fairValue.meanReversion, 0.001);
    EXPECT_EQ(config.liquidityProviders, SimConfig{}.liquidityProviders);
}

TEST(SimConfig, ZeroCountsAreAllowed) {
    const SimConfig config =
        parseSimConfigText(R"({"takers": {"count": 0}, "liquidityProviders": {"count": 0}})");
    EXPECT_EQ(config.totalAgents(), SimConfig{}.marketMakers.count);
}

TEST(SimConfig, InvalidConfigsAreRejected) {
    const std::vector<std::string> cases = {
        "",
        "[]",
        R"({"bogus": 1})",
        R"({"takers": {"rate": 2}})",
        R"({"takers": []})",
        R"({"takers": {"ratePerSecond": 0}})",
        R"({"takers": {"ratePerSecond": "2"}})",
        R"({"takers": {"sideBias": 0.6}})",
        R"({"takers": {"throughTicksMin": 3, "throughTicksMax": 1}})",
        R"({"takers": {"qty": {"min": 0, "max": 10, "mean": 5}}})",
        R"({"takers": {"qty": {"min": 5, "max": 4, "mean": 5}}})",
        R"({"takers": {"qty": {"min": 1, "max": 10, "mean": 11}}})",
        R"({"takers": {"qty": {"min": 1, "max": 10, "mean": 5, "p": 1}}})",
        R"({"takers": {"count": 1.5}})",
        R"({"takers": {"count": -1}})",
        R"({"takers": {"count": 18446744073709551615}})",
        R"({"marketMakers": {"halfSpreadTicks": 0}})",
        R"({"marketMakers": {"refreshMinSeconds": 0}})",
        R"({"marketMakers": {"refreshMinSeconds": 3, "refreshMaxSeconds": 1}})",
        R"({"liquidityProviders": {"lifetimeMeanSeconds": 0}})",
        R"({"liquidityProviders": {"behindTicksMin": 5, "behindTicksMax": 4}})",
        R"({"fairValue": {"volMin": 0}})",
        R"({"fairValue": {"initialVol": 0.01}})",
        R"({"fairValue": {"trendDecay": 1}})",
        // 999 makers plus the default takers and providers: IDs would reach 1,000.
        R"({"marketMakers": {"count": 999}})",
    };
    for (const std::string& text : cases) {
        EXPECT_THROW(parseSimConfigText(text), SimConfigError) << text;
    }
}

TEST(SimConfig, ErrorsNameTheField) {
    try {
        parseSimConfigText(R"({"takers": {"qty": {"min": 5, "max": 4, "mean": 5}}})");
        FAIL() << "expected SimConfigError";
    } catch (const SimConfigError& e) {
        EXPECT_NE(std::string(e.what()).find("takers.qty.max"), std::string::npos) << e.what();
    }
}

TEST(SimConfig, MissingFileIsAnError) {
    EXPECT_THROW(loadSimConfig("no/such/sim-config.json"), SimConfigError);
}

}  // namespace

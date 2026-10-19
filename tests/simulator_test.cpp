#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <variant>
#include <vector>

#include "Clock.h"
#include "EngineCore.h"
#include "Instrument.h"
#include "InternalProtocol.h"
#include "SimConfig.h"
#include "Simulator.h"

// The market simulator driven by a manual clock: determinism, loose
// statistical checks on the market it produces, and the boot-time warm-up.

namespace {

namespace wire = engine_service::protocol;
using engine::Side;
using engine_service::CoreConfig;
using engine_service::EngineCore;
using engine_service::EventOutput;
using engine_service::InstrumentConfig;
using engine_service::ManualClock;
using engine_service::SimConfig;
using engine_service::SimConfigError;
using engine_service::Simulator;
using engine_service::SwitchableClock;

constexpr wire::Timestamp kT0     = 1'792'252'800'000'000'000;
constexpr wire::Timestamp kSecond = 1'000'000'000;
constexpr wire::Timestamp kMinute = 60 * kSecond;
constexpr wire::Timestamp kHour   = 60 * kMinute;

const InstrumentConfig kInstrument{.symbol              = "NOVA",
                                   .name                = "Nova Dynamics",
                                   .tickSize            = "0.01",
                                   .priceDecimals       = 2,
                                   .minPriceTicks       = 1,
                                   .maxPriceTicks       = 100'000'000,
                                   .maxOrderQty         = 10'000,
                                   .referencePriceTicks = 14'250};

struct RecordingOutput final : EventOutput {
    std::vector<wire::EngineMessage> messages;
    void send(const wire::EngineMessage& message) override { messages.push_back(message); }
};

// An engine core with the simulator attached, and a recording "gateway".
struct Market {
    explicit Market(std::uint64_t seed, const SimConfig& config = SimConfig{},
                    wire::Timestamp wallTime = kT0)
        : wall(wallTime), simulator(core, config, kInstrument, seed) {
        core.setObserver(&simulator);
        core.setOutput(&gateway);
    }

    // Runs every action due up to `end` against the simulated clock, calling
    // `afterEach` (if given) after each one.
    void runUntil(wire::Timestamp end, const std::function<void(wire::Timestamp)>& afterEach = {}) {
        while (simulator.nextActionTime() <= end) {
            const wire::Timestamp t = simulator.nextActionTime();
            clock.setSimulated(t);
            simulator.runNext();
            if (afterEach) afterEach(t);
        }
    }

    ManualClock     wall;
    SwitchableClock clock{wall};
    EngineCore      core{clock, CoreConfig::forInstrument(kInstrument, std::chrono::hours(24))};
    Simulator       simulator;
    RecordingOutput gateway;
};

TEST(Simulator, SameSeedAndConfigGiveTheSameEventStream) {
    Market a(1234);
    Market b(1234);
    a.simulator.start(kT0);
    b.simulator.start(kT0);
    a.runUntil(kT0 + 10 * kMinute);
    b.runUntil(kT0 + 10 * kMinute);
    ASSERT_GT(a.gateway.messages.size(), 1000u);
    EXPECT_TRUE(a.gateway.messages == b.gateway.messages);
}

TEST(Simulator, DifferentSeedsGiveDifferentEventStreams) {
    Market a(1);
    Market b(2);
    a.simulator.start(kT0);
    b.simulator.start(kT0);
    a.runUntil(kT0 + kMinute);
    b.runUntil(kT0 + kMinute);
    EXPECT_FALSE(a.gateway.messages == b.gateway.messages);
}

TEST(Simulator, MarketMakersQuoteBothSidesAtStart) {
    Market market(5);
    market.simulator.start(kT0);
    market.runUntil(kT0);
    const engine::OrderBook& book = market.core.book();
    ASSERT_TRUE(book.bestBid().has_value());
    ASSERT_TRUE(book.bestAsk().has_value());
    EXPECT_EQ(*book.bestBid(), 14'250 - 2);
    EXPECT_EQ(*book.bestAsk(), 14'250 + 2);
}

// Over a simulated hour, check loose statistical properties of the market
// after every action. Several seeds, so one lucky path cannot hide a problem.
TEST(Simulator, SimulatedHourLooksLikeAMarket) {
    for (const std::uint64_t seed : {1u, 2u, 3u}) {
        SCOPED_TRACE(seed);
        Market market(seed);
        market.simulator.start(kT0);

        std::optional<wire::Timestamp> oneSidedSince;
        wire::Timestamp                longestOneSided = 0;
        std::vector<int>               tradesPerBucket(3600 / 5, 0);
        std::size_t                    maxResting  = 0;
        engine::Price                  lowestTrade  = 14'250;
        engine::Price                  highestTrade = 14'250;

        market.runUntil(kT0 + kHour - 1, [&](wire::Timestamp t) {
            const engine::OrderBook& book = market.core.book();
            const auto bid = book.bestBid();
            const auto ask = book.bestAsk();
            if (bid && ask) {
                ASSERT_LT(*bid, *ask) << "crossed book at t+" << (t - kT0) / kSecond << "s";
                if (oneSidedSince) longestOneSided = std::max(longestOneSided, t - *oneSidedSince);
                oneSidedSince.reset();
            } else if (!oneSidedSince) {
                oneSidedSince = t;
            }
            maxResting = std::max(maxResting, book.orderCount());

            for (const wire::EngineMessage& message : market.gateway.messages) {
                if (const auto* trade = std::get_if<wire::Trade>(&message)) {
                    ++tradesPerBucket[static_cast<std::size_t>((trade->ts - kT0) / (5 * kSecond))];
                    lowestTrade  = std::min(lowestTrade, trade->price);
                    highestTrade = std::max(highestTrade, trade->price);
                } else if (const auto* accepted = std::get_if<wire::OrderAccepted>(&message)) {
                    ASSERT_LT(accepted->traderId, 1'000u);
                    ASSERT_GE(accepted->traderId, 1u);
                }
            }
            market.gateway.messages.clear();
        });

        EXPECT_FALSE(oneSidedSince.has_value());
        EXPECT_LE(longestOneSided, 3 * kSecond);

        const auto quiet = std::count(tradesPerBucket.begin(), tradesPerBucket.end(), 0);
        EXPECT_LE(quiet, static_cast<std::ptrdiff_t>(tradesPerBucket.size() / 100))
            << quiet << " of " << tradesPerBucket.size() << " 5-second intervals had no trade";

        // Within 30% of the anchor (142.50).
        EXPECT_GT(lowestTrade, 14'250 * 7 / 10);
        EXPECT_LT(highestTrade, 14'250 * 13 / 10);

        EXPECT_EQ(market.simulator.stats().rejected, 0u);
        EXPECT_LT(maxResting, 1'000u);
        EXPECT_GT(market.simulator.stats().trades, 3'600u);
    }
}

TEST(Simulator, WarmUpBackfillsHistoryAndSwitchesToTheWallClock) {
    Market market(99);
    engine_service::warmUp(market.simulator, market.clock, kT0 - kHour);

    // Back on the wall clock, which has not moved.
    EXPECT_FALSE(market.clock.isSimulated());
    EXPECT_EQ(market.clock.now(), kT0);
    EXPECT_GT(market.simulator.nextActionTime(), kT0);

    // Retained trades span the warm-up window, and the snapshot replays them.
    RecordingOutput snapshot;
    market.core.writeSnapshot(snapshot);
    std::vector<wire::TradeReplay> replays;
    bool                           bids = false;
    bool                           asks = false;
    for (const wire::EngineMessage& message : snapshot.messages) {
        if (const auto* replay = std::get_if<wire::TradeReplay>(&message)) {
            replays.push_back(*replay);
        } else if (const auto* resting = std::get_if<wire::RestingOrder>(&message)) {
            (resting->side == Side::Buy ? bids : asks) = true;
            EXPECT_LT(resting->traderId, 1'000u);
        }
    }
    ASSERT_EQ(replays.size(), market.core.retainedTradeCount());
    ASSERT_GT(replays.size(), 3'600u);
    EXPECT_GE(replays.front().ts, kT0 - kHour);
    EXPECT_LT(replays.front().ts, kT0 - kHour + kMinute);
    EXPECT_LE(replays.back().ts, kT0);
    EXPECT_GT(replays.back().ts, kT0 - kMinute);
    EXPECT_TRUE(std::is_sorted(replays.begin(), replays.end(),
                               [](const auto& a, const auto& b) { return a.ts < b.ts; }));
    EXPECT_TRUE(bids);
    EXPECT_TRUE(asks);

    // Live running continues from the warm-up's resting orders, stamped with
    // wall-clock time.
    market.gateway.messages.clear();
    market.wall.advance(5 * kSecond);
    market.simulator.runDue(market.clock.now());
    ASSERT_FALSE(market.gateway.messages.empty());
    for (const wire::EngineMessage& message : market.gateway.messages) {
        std::visit(
            [](const auto& m) {
                if constexpr (requires { m.ts; }) EXPECT_EQ(m.ts, kT0 + 5 * kSecond);
            },
            message);
    }
}

TEST(Simulator, HumansTradeWithTheSimulatedTraders) {
    Market market(7);
    engine_service::warmUp(market.simulator, market.clock, kT0 - 10 * kMinute);
    market.gateway.messages.clear();

    const engine::Price ask = *market.core.book().bestAsk();
    market.core.submit({.clientTag = 1, .traderId = 1'000'000, .side = Side::Buy, .price = ask,
                        .qty = 1});
    bool traded = false;
    for (const wire::EngineMessage& message : market.gateway.messages) {
        if (const auto* trade = std::get_if<wire::Trade>(&message)) {
            traded = true;
            EXPECT_EQ(trade->buyerTraderId, 1'000'000u);
            EXPECT_LT(trade->sellerTraderId, 1'000u);
        }
    }
    EXPECT_TRUE(traded);

    // The simulator carries on, and is unaffected by the human's order.
    market.wall.advance(kMinute);
    market.simulator.runDue(market.clock.now());
    EXPECT_EQ(market.simulator.stats().rejected, 0u);
}

TEST(Simulator, WorksWithOnlyMarketMakers) {
    SimConfig config;
    config.takers.count             = 0;
    config.liquidityProviders.count = 0;
    Market market(3, config);
    market.simulator.start(kT0);
    market.runUntil(kT0 + 10 * kMinute);
    EXPECT_EQ(market.simulator.agentCount(), config.marketMakers.count);
    EXPECT_EQ(market.simulator.stats().rejected, 0u);
    EXPECT_TRUE(market.core.book().bestBid().has_value());
    EXPECT_TRUE(market.core.book().bestAsk().has_value());
}

TEST(Simulator, OrderSizesMustFitTheInstrument) {
    SimConfig config;
    config.takers.qty = {.min = 1, .max = kInstrument.maxOrderQty + 1, .mean = 10};
    ManualClock     wall(kT0);
    SwitchableClock clock(wall);
    EngineCore      core(clock, CoreConfig::forInstrument(kInstrument, std::chrono::hours(24)));
    EXPECT_THROW({ Simulator simulator(core, config, kInstrument, 1); }, SimConfigError);
}

}  // namespace

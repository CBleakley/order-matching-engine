#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <queue>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <variant>
#include <vector>

#include "Clock.h"
#include "EngineCore.h"
#include "FairValueModel.h"
#include "Instrument.h"
#include "InternalProtocol.h"
#include "SimConfig.h"
#include "SimRandom.h"
#include "Types.h"

// Simulated traders that keep the market busy: market makers keep the book
// two-sided around a fair value, takers trade against them, and liquidity
// providers add depth behind the touch.
//
// The simulator is a discrete-event simulation with no clock or timers of its
// own: actions sit in a queue keyed by the (simulated or wall) time they are
// due, and the owner runs them. warmUp() runs them as fast as possible against
// a simulated clock; LiveSimulation (SimulationRunner.h) runs them from an Asio
// timer. Either way, given the same seed, config and action times, the
// simulator submits exactly the same orders.
//
// Agents submit and cancel through EngineCore, like the gateway, so their
// orders are validated and reported identically. They learn about their own
// orders only from the events addressed to them (the simulator is the core's
// observer), plus public market data: the best bid and ask, and the last trade
// price. They never act from inside an event callback.

namespace engine_service {

struct SimulatorStats {
    std::uint64_t actions   = 0;  // queue actions run
    std::uint64_t submitted = 0;  // orders the agents sent
    std::uint64_t cancelled = 0;  // cancels the agents sent
    std::uint64_t rejected  = 0;  // rejections of agents' submits or cancels
    std::uint64_t trades    = 0;  // trades seen, from any trader
};

class Simulator final : public EventOutput {
public:
    // Throws SimConfigError if an order size exceeds the instrument's limit.
    Simulator(EngineCore& core, const SimConfig& config, const InstrumentConfig& instrument,
              std::uint64_t seed)
        : core_(core), config_(config), minPrice_(instrument.minPriceTicks),
          maxPrice_(instrument.maxPriceTicks), random_(seed),
          fairValue_(config.fairValue, instrument.referencePriceTicks),
          agents_(config.totalAgents()) {
        checkQty(config.marketMakers.qty, "marketMakers.qty.max", instrument);
        checkQty(config.takers.qty, "takers.qty.max", instrument);
        checkQty(config.liquidityProviders.qty, "liquidityProviders.qty.max", instrument);
        makers_.resize(config.marketMakers.count);
        for (std::uint32_t i = 0; i < config.marketMakers.count; ++i) {
            makers_[i].trader     = firstMakerId() + i;
            makers_[i].halfSpread = config.marketMakers.halfSpreadTicks +
                                    static_cast<engine::Price>(i) *
                                        config.marketMakers.halfSpreadStepTicks;
        }
    }

    Simulator(const Simulator&)            = delete;
    Simulator& operator=(const Simulator&) = delete;

    // Schedules the first actions: every market maker quotes at t0, fair value
    // first moves at t0 + 1s, and the first taker and provider arrivals follow
    // their Poisson processes. Call once.
    void start(protocol::Timestamp t0) {
        for (std::uint32_t i = 0; i < makers_.size(); ++i) {
            schedule(t0, ActionKind::MakerRefresh, i);
        }
        schedule(t0 + kSecond, ActionKind::FairValueStep);
        if (config_.takers.count > 0) scheduleTakerArrival(t0);
        if (config_.liquidityProviders.count > 0) scheduleProviderArrival(t0);
    }

    // When the next action is due, or the largest timestamp if none is.
    protocol::Timestamp nextActionTime() const noexcept {
        return queue_.empty() ? std::numeric_limits<protocol::Timestamp>::max()
                              : queue_.top().time;
    }

    // Runs the earliest due action. The core's clock decides the timestamps
    // of the events it causes.
    void runNext() {
        if (queue_.empty()) return;
        const Action action = queue_.top();
        queue_.pop();
        ++stats_.actions;
        run(action);
    }

    // Runs every action due at or before `now`, in time order.
    void runDue(protocol::Timestamp now) {
        while (nextActionTime() <= now) runNext();
    }

    // EventOutput (as the core's observer): follows the agents' own orders.
    void send(const protocol::EngineMessage& message) override {
        std::visit([this](const auto& m) { observe(m); }, message);
    }

    const SimulatorStats& stats() const noexcept { return stats_; }
    double                fairValue() const noexcept { return fairValue_.price(); }
    std::uint32_t         agentCount() const noexcept {
        return static_cast<std::uint32_t>(agents_.size());
    }

    // Simulated traders have IDs 1..agentCount(), all below 1,000.
    bool isAgent(engine::TraderId trader) const noexcept {
        return trader >= 1 && trader <= agents_.size();
    }

private:
    static constexpr protocol::Timestamp kSecond = 1'000'000'000;

    enum class ActionKind : std::uint8_t {
        FairValueStep,
        MakerRefresh,     // index: market maker
        TakerArrival,
        ProviderArrival,
        ProviderExpire,   // index: provider's trader ID, orderId: its order
    };

    struct Action {
        protocol::Timestamp time;
        std::uint64_t       seq;  // ties run in the order they were scheduled
        ActionKind          kind;
        std::uint32_t       index;
        engine::OrderId     orderId;
    };

    struct Later {
        bool operator()(const Action& a, const Action& b) const noexcept {
            return a.time != b.time ? a.time > b.time : a.seq > b.seq;
        }
    };

    // What one simulated trader knows about its own orders, from its events.
    struct AgentOrders {
        std::unordered_map<engine::OrderId, engine::Quantity> resting;  // id -> remaining
        protocol::ClientTag awaitingTag = 0;  // the submit in progress
        engine::OrderId     acceptedId  = 0;  // its order ID, once accepted
    };

    struct MarketMaker {
        engine::TraderId trader     = 0;
        engine::Price    halfSpread = 0;
        engine::OrderId  bid        = 0;
        engine::OrderId  ask        = 0;
        engine::Price    quotedMid  = 0;
    };

    // ---- Actions -----------------------------------------------------------

    void run(const Action& action) {
        switch (action.kind) {
            case ActionKind::FairValueStep:   stepFairValue(action.time); break;
            case ActionKind::MakerRefresh:    refreshMaker(action.time, action.index); break;
            case ActionKind::TakerArrival:    takerArrives(action.time); break;
            case ActionKind::ProviderArrival: providerArrives(action.time); break;
            case ActionKind::ProviderExpire:
                cancelIfResting(action.index, action.orderId);
                break;
        }
    }

    void stepFairValue(protocol::Timestamp now) {
        fairValue_.step(random_);
        const engine::Price fv = fairValueTicks();
        for (MarketMaker& maker : makers_) {
            const engine::Price moved = fv > maker.quotedMid ? fv - maker.quotedMid
                                                             : maker.quotedMid - fv;
            if (moved >= config_.marketMakers.requoteThresholdTicks) quote(maker);
        }
        schedule(now + kSecond, ActionKind::FairValueStep);
    }

    void refreshMaker(protocol::Timestamp now, std::uint32_t index) {
        quote(makers_[index]);
        const double delay = random_.uniform(config_.marketMakers.refreshMinSeconds,
                                             config_.marketMakers.refreshMaxSeconds);
        schedule(now + seconds(delay), ActionKind::MakerRefresh, index);
    }

    // Cancels the maker's quotes, then quotes a bid and an ask around fair value.
    void quote(MarketMaker& maker) {
        cancelIfResting(maker.trader, maker.bid);
        cancelIfResting(maker.trader, maker.ask);
        const engine::Price mid = fairValueTicks();
        maker.quotedMid = mid;
        maker.bid = submit(maker.trader, engine::Side::Buy, mid - maker.halfSpread,
                           sampleQty(config_.marketMakers.qty));
        maker.ask = submit(maker.trader, engine::Side::Sell, mid + maker.halfSpread,
                           sampleQty(config_.marketMakers.qty));
    }

    // A taker buys or sells a few ticks through the touch, leaning toward fair
    // value when the last trade is away from it, and cancels any remainder.
    void takerArrives(protocol::Timestamp now) {
        const TakerConfig& c = config_.takers;
        const auto trader = static_cast<engine::TraderId>(
            random_.uniformInt(firstTakerId(), firstTakerId() + c.count - 1));

        const double last = lastTradePrice_ ? static_cast<double>(*lastTradePrice_)
                                            : fairValue_.price();
        const double lean = std::clamp((fairValue_.price() - last) / c.biasScaleTicks, -1.0, 1.0);
        const bool   buy  = random_.chance(0.5 + c.sideBias * lean);

        const engine::Price through = random_.uniformInt(c.throughTicksMin, c.throughTicksMax);
        const engine::Price spread  = config_.marketMakers.halfSpreadTicks;
        engine::Price       price   = 0;
        if (buy) {
            const auto ask = core_.book().bestAsk();
            price          = (ask ? *ask : fairValueTicks() + spread) + through;
        } else {
            const auto bid = core_.book().bestBid();
            price          = (bid ? *bid : fairValueTicks() - spread) - through;
        }
        const engine::OrderId id = submit(trader, buy ? engine::Side::Buy : engine::Side::Sell,
                                          price, sampleQty(c.qty));
        cancelIfResting(trader, id);
        scheduleTakerArrival(now);
    }

    // A provider rests an order a few ticks behind the touch on a random side,
    // and cancels it after a random lifetime.
    void providerArrives(protocol::Timestamp now) {
        const LiquidityProviderConfig& c = config_.liquidityProviders;
        const auto trader = static_cast<engine::TraderId>(
            random_.uniformInt(firstProviderId(), firstProviderId() + c.count - 1));
        const bool          buy    = random_.chance(0.5);
        const engine::Price behind = random_.uniformInt(c.behindTicksMin, c.behindTicksMax);
        const engine::Price spread = config_.marketMakers.halfSpreadTicks;
        engine::Price       price  = 0;
        if (buy) {
            const auto bid = core_.book().bestBid();
            price          = (bid ? *bid : fairValueTicks() - spread) - behind;
        } else {
            const auto ask = core_.book().bestAsk();
            price          = (ask ? *ask : fairValueTicks() + spread) + behind;
        }
        const engine::OrderId id = submit(trader, buy ? engine::Side::Buy : engine::Side::Sell,
                                          price, sampleQty(c.qty));
        if (isResting(trader, id)) {
            schedule(now + seconds(random_.exponential(c.lifetimeMeanSeconds)),
                     ActionKind::ProviderExpire, trader, id);
        }
        scheduleProviderArrival(now);
    }

    void scheduleTakerArrival(protocol::Timestamp now) {
        schedule(now + seconds(random_.exponential(1.0 / config_.takers.ratePerSecond)),
                 ActionKind::TakerArrival);
    }

    void scheduleProviderArrival(protocol::Timestamp now) {
        schedule(now + seconds(random_.exponential(1.0 / config_.liquidityProviders.ratePerSecond)),
                 ActionKind::ProviderArrival);
    }

    // ---- Order entry -------------------------------------------------------

    // Submits through the core and returns the order ID it assigned (learned
    // from OrderAccepted), or 0 if the order was rejected.
    engine::OrderId submit(engine::TraderId trader, engine::Side side, engine::Price price,
                           engine::Quantity qty) {
        AgentOrders& agent = agents_[trader - 1];
        agent.awaitingTag  = nextClientTag_++;
        agent.acceptedId   = 0;
        ++stats_.submitted;
        core_.submit({.clientTag = agent.awaitingTag,
                      .traderId  = trader,
                      .side      = side,
                      .price     = std::clamp(price, minPrice_, maxPrice_),
                      .qty       = qty});
        agent.awaitingTag = 0;
        return agent.acceptedId;
    }

    bool isResting(engine::TraderId trader, engine::OrderId id) const {
        return id != 0 && agents_[trader - 1].resting.contains(id);
    }

    void cancelIfResting(engine::TraderId trader, engine::OrderId id) {
        if (!isResting(trader, id)) return;
        ++stats_.cancelled;
        core_.cancel({.clientTag = nextClientTag_++, .traderId = trader, .orderId = id});
    }

    // ---- Events ------------------------------------------------------------

    template <class M>
    void observe(const M& m) {
        if constexpr (std::is_same_v<M, protocol::OrderAccepted>) {
            if (!isAgent(m.traderId)) return;
            AgentOrders& agent = agents_[m.traderId - 1];
            if (m.clientTag == agent.awaitingTag) agent.acceptedId = m.orderId;
        } else if constexpr (std::is_same_v<M, protocol::OrderRejected>) {
            if (isAgent(m.traderId)) ++stats_.rejected;
        } else if constexpr (std::is_same_v<M, protocol::OrderRested>) {
            if (isAgent(m.traderId)) agents_[m.traderId - 1].resting[m.orderId] = m.remainingQty;
        } else if constexpr (std::is_same_v<M, protocol::Trade>) {
            ++stats_.trades;
            lastTradePrice_ = m.price;
            // The maker is on the side opposite the aggressor.
            const engine::TraderId maker =
                m.aggressorSide == engine::Side::Buy ? m.sellerTraderId : m.buyerTraderId;
            if (!isAgent(maker)) return;
            auto&      resting = agents_[maker - 1].resting;
            const auto it      = resting.find(m.makerOrderId);
            if (it == resting.end()) return;
            it->second -= m.qty;
            if (it->second <= 0) resting.erase(it);
        } else if constexpr (std::is_same_v<M, protocol::OrderCancelled>) {
            if (isAgent(m.traderId)) agents_[m.traderId - 1].resting.erase(m.orderId);
        }
        // Other messages (snapshot, heartbeats) are never live events.
    }

    // ---- Helpers -----------------------------------------------------------

    void schedule(protocol::Timestamp time, ActionKind kind, std::uint32_t index = 0,
                  engine::OrderId orderId = 0) {
        queue_.push({.time = time, .seq = nextActionSeq_++, .kind = kind, .index = index,
                     .orderId = orderId});
    }

    static protocol::Timestamp seconds(double s) {
        return static_cast<protocol::Timestamp>(std::llround(s * static_cast<double>(kSecond)));
    }

    engine::Price fairValueTicks() const { return fairValue_.ticks(minPrice_, maxPrice_); }

    engine::Quantity sampleQty(const QtyDistribution& d) {
        const double extra = random_.exponential(d.mean - static_cast<double>(d.min));
        const auto   qty   = d.min + static_cast<engine::Quantity>(std::llround(extra));
        return std::min(qty, d.max);
    }

    static void checkQty(const QtyDistribution& d, const char* field,
                         const InstrumentConfig& instrument) {
        if (d.max > instrument.maxOrderQty) {
            throw SimConfigError("Invalid sim config: " + std::string(field) +
                                 " must not exceed the instrument's maxOrderQty (" +
                                 std::to_string(instrument.maxOrderQty) + ")");
        }
    }

    std::uint32_t firstMakerId() const noexcept { return 1; }
    std::uint32_t firstTakerId() const noexcept { return 1 + config_.marketMakers.count; }
    std::uint32_t firstProviderId() const noexcept {
        return firstTakerId() + config_.takers.count;
    }

    EngineCore&    core_;
    SimConfig      config_;
    engine::Price  minPrice_;
    engine::Price  maxPrice_;
    SimRandom      random_;
    FairValueModel fairValue_;

    std::vector<AgentOrders>  agents_;  // indexed by trader ID - 1
    std::vector<MarketMaker>  makers_;
    std::optional<engine::Price> lastTradePrice_;

    std::priority_queue<Action, std::vector<Action>, Later> queue_;
    std::uint64_t       nextActionSeq_ = 0;
    protocol::ClientTag nextClientTag_ = 1;
    SimulatorStats      stats_;
};

// Backfills history at boot: starts the simulator at `from` and runs its
// actions as fast as possible, pinning the clock to each action's time so
// events are stamped with simulated time, until it catches up with the wall
// clock. Then switches the clock to the wall clock for live running. Resting
// orders carry over.
inline void warmUp(Simulator& simulator, SwitchableClock& clock, protocol::Timestamp from) {
    simulator.start(from);
    // Re-reading the wall clock each time also covers the time warm-up takes.
    while (simulator.nextActionTime() <= clock.wall().now()) {
        clock.setSimulated(simulator.nextActionTime());
        simulator.runNext();
    }
    clock.useWall();
}

}  // namespace engine_service

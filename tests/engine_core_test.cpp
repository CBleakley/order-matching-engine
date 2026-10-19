#include <gtest/gtest.h>

#include <chrono>
#include <variant>
#include <vector>

#include "Clock.h"
#include "EngineCore.h"
#include "InternalProtocol.h"

// EngineCore without sockets: decoded commands in, exact protocol events out.

namespace {

namespace wire = engine_service::protocol;
using engine::Side;
using engine_service::CoreConfig;
using engine_service::EngineCore;
using engine_service::EventOutput;
using engine_service::ManualClock;

struct RecordingOutput final : EventOutput {
    std::vector<wire::EngineMessage> messages;
    void send(const wire::EngineMessage& message) override { messages.push_back(message); }
};

constexpr wire::Timestamp kT0 = 1'792'252'800'000'000'000;
constexpr engine::TraderId kAlice = 1'000'000;
constexpr engine::TraderId kBob   = 1'000'001;

constexpr wire::Timestamp kHour = 3'600'000'000'000;

const CoreConfig kConfig{.minPriceTicks  = 1,
                         .maxPriceTicks  = 100'000,
                         .maxOrderQty    = 10'000,
                         .tradeRetention = std::chrono::hours(24)};

class EngineCoreTest : public ::testing::Test {
protected:
    EngineCoreTest() { core.setOutput(&out); }

    void submit(wire::ClientTag tag, engine::TraderId trader, Side side, engine::Price price,
                engine::Quantity qty) {
        core.submit({.clientTag = tag, .traderId = trader, .side = side, .price = price,
                     .qty = qty});
    }
    void cancel(wire::ClientTag tag, engine::TraderId trader, engine::OrderId id) {
        core.cancel({.clientTag = tag, .traderId = trader, .orderId = id});
    }

    // Returns and clears the recorded events.
    std::vector<wire::EngineMessage> take() {
        std::vector<wire::EngineMessage> messages;
        messages.swap(out.messages);
        return messages;
    }

    ManualClock     clock{kT0};
    EngineCore      core{clock, kConfig};
    RecordingOutput out;
};

using Events = std::vector<wire::EngineMessage>;

TEST_F(EngineCoreTest, RestingOrder) {
    submit(10, kAlice, Side::Buy, 14'250, 100);
    EXPECT_EQ(take(), (Events{
        wire::OrderAccepted{.eventSeq = 1, .ts = kT0, .clientTag = 10, .orderId = 1,
                            .traderId = kAlice, .side = Side::Buy, .price = 14'250, .qty = 100},
        wire::OrderRested{.eventSeq = 2, .ts = kT0, .orderId = 1, .traderId = kAlice,
                          .side = Side::Buy, .price = 14'250, .remainingQty = 100},
    }));
    EXPECT_EQ(core.nextOrderId(), 2u);
    EXPECT_EQ(core.nextEventSeq(), 3u);
}

TEST_F(EngineCoreTest, CrossingOrdersTradeAtTheRestingPrice) {
    submit(1, kAlice, Side::Sell, 14'250, 30);
    take();
    clock.advance(5'000);

    submit(2, kBob, Side::Buy, 14'300, 50);
    const wire::Timestamp t1 = kT0 + 5'000;
    EXPECT_EQ(take(), (Events{
        wire::OrderAccepted{.eventSeq = 3, .ts = t1, .clientTag = 2, .orderId = 2,
                            .traderId = kBob, .side = Side::Buy, .price = 14'300, .qty = 50},
        wire::Trade{.eventSeq = 4, .ts = t1, .makerOrderId = 1, .takerOrderId = 2,
                    .buyerTraderId = kBob, .sellerTraderId = kAlice, .price = 14'250, .qty = 30,
                    .aggressorSide = Side::Buy},
        wire::OrderRested{.eventSeq = 5, .ts = t1, .orderId = 2, .traderId = kBob,
                          .side = Side::Buy, .price = 14'300, .remainingQty = 20},
    }));
}

TEST_F(EngineCoreTest, SweepAcrossLevelsFillsBestPriceFirst) {
    submit(1, kAlice, Side::Buy, 100, 10);
    submit(2, kAlice, Side::Buy, 102, 10);
    take();

    submit(3, kBob, Side::Sell, 101, 15);
    EXPECT_EQ(take(), (Events{
        wire::OrderAccepted{.eventSeq = 5, .ts = kT0, .clientTag = 3, .orderId = 3,
                            .traderId = kBob, .side = Side::Sell, .price = 101, .qty = 15},
        wire::Trade{.eventSeq = 6, .ts = kT0, .makerOrderId = 2, .takerOrderId = 3,
                    .buyerTraderId = kAlice, .sellerTraderId = kBob, .price = 102, .qty = 10,
                    .aggressorSide = Side::Sell},
        wire::OrderRested{.eventSeq = 7, .ts = kT0, .orderId = 3, .traderId = kBob,
                          .side = Side::Sell, .price = 101, .remainingQty = 5},
    }));
}

TEST_F(EngineCoreTest, CancelReportsTheOwnerAndRemainingQty) {
    submit(1, kAlice, Side::Sell, 200, 40);
    submit(2, kBob, Side::Buy, 200, 15);  // partially fills order 1
    take();
    clock.advance(1);

    cancel(3, kAlice, 1);
    EXPECT_EQ(take(), (Events{
        wire::OrderCancelled{.eventSeq = 5, .ts = kT0 + 1, .orderId = 1, .traderId = kAlice,
                             .cancelledQty = 25},
    }));
}

TEST_F(EngineCoreTest, CancelOfUnknownOrderIsRejectedWithItsId) {
    cancel(9, kAlice, 42);
    EXPECT_EQ(take(), (Events{
        wire::OrderRejected{.eventSeq = 1, .ts = kT0, .clientTag = 9, .orderId = 42,
                            .traderId = kAlice, .reason = wire::RejectCode::UnknownOrderId},
    }));
}

TEST_F(EngineCoreTest, CancelOfFilledOrderIsRejected) {
    submit(1, kAlice, Side::Sell, 200, 10);
    submit(2, kBob, Side::Buy, 200, 10);
    take();
    cancel(3, kAlice, 1);
    const Events events = take();
    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(std::get<wire::OrderRejected>(events[0]).reason, wire::RejectCode::UnknownOrderId);
}

TEST_F(EngineCoreTest, RejectedSubmitsDoNotConsumeOrderIds) {
    submit(1, kAlice, Side::Buy, 0, 10);
    submit(2, kAlice, Side::Buy, 100, -1);
    EXPECT_EQ(take(), (Events{
        wire::OrderRejected{.eventSeq = 1, .ts = kT0, .clientTag = 1, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::PriceOutOfRange},
        wire::OrderRejected{.eventSeq = 2, .ts = kT0, .clientTag = 2, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::QtyOutOfRange},
    }));

    submit(3, kAlice, Side::Buy, 100, 10);
    const Events events = take();
    ASSERT_FALSE(events.empty());
    EXPECT_EQ(std::get<wire::OrderAccepted>(events[0]).orderId, 1u);
}

TEST_F(EngineCoreTest, EventSeqKeepsCountingWithNoOutputAttached) {
    core.setOutput(nullptr);
    submit(1, kAlice, Side::Buy, 100, 10);  // accepted + rested: eventSeq 1 and 2
    EXPECT_TRUE(out.messages.empty());

    core.setOutput(&out);
    submit(2, kAlice, Side::Buy, 100, 10);
    const Events events = take();
    ASSERT_FALSE(events.empty());
    EXPECT_EQ(std::get<wire::OrderAccepted>(events[0]).eventSeq, 3u);
    EXPECT_EQ(std::get<wire::OrderAccepted>(events[0]).orderId, 2u);
}

// The order IDs of the OrderAccepted events in `events`.
std::vector<engine::OrderId> acceptedIds(const Events& events) {
    std::vector<engine::OrderId> ids;
    for (const auto& event : events) {
        if (const auto* accepted = std::get_if<wire::OrderAccepted>(&event)) {
            ids.push_back(accepted->orderId);
        }
    }
    return ids;
}

TEST_F(EngineCoreTest, OrderIdsCountUpFromOneWithNoGapsForRejections) {
    submit(1, kAlice, Side::Buy, 100, 10);
    submit(2, kAlice, Side::Buy, 0, 10);       // bad price
    submit(3, kAlice, Side::Buy, 100, 0);      // bad quantity
    cancel(4, kAlice, 99);                     // unknown order
    submit(5, kBob, Side::Sell, 200, 10);
    cancel(6, kBob, 1);                        // not the owner
    submit(7, kBob, Side::Sell, 100, 10);      // fills order 1 completely
    submit(8, kAlice, Side::Buy, 100'001, 1);  // bad price
    submit(9, kAlice, Side::Buy, 150, 1);
    EXPECT_EQ(acceptedIds(take()), (std::vector<engine::OrderId>{1, 2, 3, 4}));
    EXPECT_EQ(core.nextOrderId(), 5u);
}

TEST_F(EngineCoreTest, PriceMustBeWithinTheInstrumentLimits) {
    clock.advance(7);
    submit(1, kAlice, Side::Buy, kConfig.minPriceTicks - 1, 10);
    submit(2, kAlice, Side::Sell, kConfig.maxPriceTicks + 1, 10);
    EXPECT_EQ(take(), (Events{
        wire::OrderRejected{.eventSeq = 1, .ts = kT0 + 7, .clientTag = 1, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::PriceOutOfRange},
        wire::OrderRejected{.eventSeq = 2, .ts = kT0 + 7, .clientTag = 2, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::PriceOutOfRange},
    }));
    EXPECT_EQ(core.book().orderCount(), 0u);

    submit(3, kAlice, Side::Buy, kConfig.minPriceTicks, 10);
    submit(4, kAlice, Side::Sell, kConfig.maxPriceTicks, 10);
    EXPECT_EQ(acceptedIds(take()), (std::vector<engine::OrderId>{1, 2}));
}

TEST_F(EngineCoreTest, QuantityMustBeWithinTheInstrumentLimits) {
    submit(1, kAlice, Side::Buy, 100, 0);
    submit(2, kAlice, Side::Buy, 100, kConfig.maxOrderQty + 1);
    submit(3, kAlice, Side::Buy, 100, -5);
    EXPECT_EQ(take(), (Events{
        wire::OrderRejected{.eventSeq = 1, .ts = kT0, .clientTag = 1, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::QtyOutOfRange},
        wire::OrderRejected{.eventSeq = 2, .ts = kT0, .clientTag = 2, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::QtyOutOfRange},
        wire::OrderRejected{.eventSeq = 3, .ts = kT0, .clientTag = 3, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::QtyOutOfRange},
    }));

    submit(4, kAlice, Side::Buy, 100, 1);
    submit(5, kAlice, Side::Buy, 100, kConfig.maxOrderQty);
    EXPECT_EQ(acceptedIds(take()), (std::vector<engine::OrderId>{1, 2}));
}

TEST_F(EngineCoreTest, BadPriceIsReportedBeforeBadQuantity) {
    submit(1, kAlice, Side::Buy, 0, 0);
    const Events events = take();
    ASSERT_EQ(events.size(), 1u);
    EXPECT_EQ(std::get<wire::OrderRejected>(events[0]).reason, wire::RejectCode::PriceOutOfRange);
}

TEST_F(EngineCoreTest, CancelByNonOwnerIsRejectedAndLeavesTheOrderUntouched) {
    submit(1, kAlice, Side::Sell, 200, 40);
    take();
    clock.advance(3);

    cancel(2, kBob, 1);
    EXPECT_EQ(take(), (Events{
        wire::OrderRejected{.eventSeq = 3, .ts = kT0 + 3, .clientTag = 2, .orderId = 1,
                            .traderId = kBob, .reason = wire::RejectCode::NotOwner},
    }));
    EXPECT_EQ(core.book().orderCount(), 1u);
    EXPECT_EQ(core.book().volumeAt(Side::Sell, 200), 40);

    // The order is still live: it trades, and its owner can cancel it.
    submit(3, kBob, Side::Buy, 200, 10);  // accepted (4) and trade (5)
    take();
    cancel(4, kAlice, 1);
    EXPECT_EQ(take(), (Events{
        wire::OrderCancelled{.eventSeq = 6, .ts = kT0 + 3, .orderId = 1, .traderId = kAlice,
                             .cancelledQty = 30},
    }));
}

// The snapshot `core` writes, collected apart from the live output.
Events snapshot(EngineCore& core) {
    RecordingOutput out;
    core.writeSnapshot(out);
    return out.messages;
}

TEST_F(EngineCoreTest, SnapshotOfAnEmptyEngine) {
    EXPECT_EQ(snapshot(core), (Events{wire::SnapshotBegin{.eventSeq = 1},
                                      wire::SnapshotEnd{.eventSeq = 1}}));
}

TEST_F(EngineCoreTest, SnapshotHoldsRestingOrdersInPriceTimeOrderAndRetainedTrades) {
    const wire::Timestamp t1 = kT0 + 1'000;
    const wire::Timestamp t2 = kT0 + 2'000;
    const wire::Timestamp t3 = kT0 + 3'000;

    submit(1, kAlice, Side::Buy, 100, 10);   // order 1
    submit(2, kBob, Side::Buy, 101, 20);     // order 2: best bid
    submit(3, kAlice, Side::Buy, 100, 30);   // order 3: behind order 1
    submit(4, kBob, Side::Sell, 105, 40);    // order 4
    submit(5, kAlice, Side::Sell, 103, 50);  // order 5: best ask
    clock.set(t1);
    submit(6, kBob, Side::Buy, 100, 60);     // order 6: cancelled below
    clock.set(t2);
    submit(7, kAlice, Side::Sell, 101, 25);  // order 7: fills order 2, rests 5 @ 101
    clock.set(t3);
    submit(8, kBob, Side::Buy, 103, 15);     // order 8: fills order 7, then 10 of order 5
    cancel(9, kBob, 6);

    // Keep the live trades to compare with the replay.
    std::vector<wire::Trade> trades;
    for (const auto& event : take()) {
        if (const auto* trade = std::get_if<wire::Trade>(&event)) trades.push_back(*trade);
    }
    ASSERT_EQ(trades.size(), 3u);

    const wire::EventSeq next = core.nextEventSeq();
    EXPECT_EQ(snapshot(core), (Events{
        wire::SnapshotBegin{.eventSeq = next},
        // Bids, best price first, FIFO within a level.
        wire::RestingOrder{.orderId = 1, .traderId = kAlice, .side = Side::Buy, .price = 100,
                           .originalQty = 10, .remainingQty = 10, .acceptedAt = kT0},
        wire::RestingOrder{.orderId = 3, .traderId = kAlice, .side = Side::Buy, .price = 100,
                           .originalQty = 30, .remainingQty = 30, .acceptedAt = kT0},
        // Asks, best price first.
        wire::RestingOrder{.orderId = 5, .traderId = kAlice, .side = Side::Sell, .price = 103,
                           .originalQty = 50, .remainingQty = 40, .acceptedAt = kT0},
        wire::RestingOrder{.orderId = 4, .traderId = kBob, .side = Side::Sell, .price = 105,
                           .originalQty = 40, .remainingQty = 40, .acceptedAt = kT0},
        // Trades, oldest first, keeping their original eventSeq and ts.
        wire::TradeReplay{.eventSeq = trades[0].eventSeq, .ts = t2, .makerOrderId = 2,
                          .takerOrderId = 7, .buyerTraderId = kBob, .sellerTraderId = kAlice,
                          .price = 101, .qty = 20, .aggressorSide = Side::Sell},
        wire::TradeReplay{.eventSeq = trades[1].eventSeq, .ts = t3, .makerOrderId = 7,
                          .takerOrderId = 8, .buyerTraderId = kBob, .sellerTraderId = kAlice,
                          .price = 101, .qty = 5, .aggressorSide = Side::Buy},
        wire::TradeReplay{.eventSeq = trades[2].eventSeq, .ts = t3, .makerOrderId = 5,
                          .takerOrderId = 8, .buyerTraderId = kBob, .sellerTraderId = kAlice,
                          .price = 103, .qty = 10, .aggressorSide = Side::Buy},
        wire::SnapshotEnd{.eventSeq = next},
    }));

    // A partially filled order rested later keeps its own acceptedAt.
    submit(10, kBob, Side::Sell, 100, 15);   // order 9: fills order 1 and 5 of order 3
    clock.set(t3 + 1);
    submit(11, kAlice, Side::Sell, 110, 5);  // order 10
    take();
    const Events later = snapshot(core);
    ASSERT_EQ(later.size(), 2u + 4u + 5u);
    EXPECT_EQ(later[1], wire::EngineMessage(wire::RestingOrder{
                            .orderId = 3, .traderId = kAlice, .side = Side::Buy, .price = 100,
                            .originalQty = 30, .remainingQty = 25, .acceptedAt = kT0}));
    EXPECT_EQ(later[4], wire::EngineMessage(wire::RestingOrder{
                            .orderId = 10, .traderId = kAlice, .side = Side::Sell, .price = 110,
                            .originalQty = 5, .remainingQty = 5, .acceptedAt = t3 + 1}));

    // The snapshot consumes no eventSeq: live events continue from SnapshotEnd's.
    const wire::EventSeq advertised = std::get<wire::SnapshotEnd>(later.back()).eventSeq;
    EXPECT_EQ(core.nextEventSeq(), advertised);
    submit(12, kAlice, Side::Buy, 99, 1);
    const Events live = take();
    ASSERT_FALSE(live.empty());
    EXPECT_EQ(std::get<wire::OrderAccepted>(live[0]).eventSeq, advertised);
}

TEST_F(EngineCoreTest, TradesOlderThanTheRetentionPeriodAreNotReplayed) {
    constexpr wire::Timestamp kRetention = 24 * kHour;
    const auto trade = [this](engine::Quantity qty) {
        submit(1, kAlice, Side::Sell, 100, qty);
        submit(2, kBob, Side::Buy, 100, qty);
    };
    const auto replayedQtys = [this] {
        std::vector<engine::Quantity> qtys;
        for (const auto& message : snapshot(core)) {
            if (const auto* replay = std::get_if<wire::TradeReplay>(&message)) {
                qtys.push_back(replay->qty);
            }
        }
        return qtys;
    };

    trade(1);  // at kT0
    clock.set(kT0 + 2 * kHour);
    trade(2);
    clock.set(kT0 + 3 * kHour);
    trade(3);
    EXPECT_EQ(replayedQtys(), (std::vector<engine::Quantity>{1, 2, 3}));

    // Exactly the retention period old: still kept.
    clock.set(kT0 + kRetention);
    EXPECT_EQ(replayedQtys(), (std::vector<engine::Quantity>{1, 2, 3}));

    clock.set(kT0 + kRetention + 1);
    EXPECT_EQ(replayedQtys(), (std::vector<engine::Quantity>{2, 3}));

    // A new trade evicts expired ones too, without waiting for a snapshot.
    clock.set(kT0 + 2 * kHour + kRetention + 1);
    EXPECT_EQ(core.retainedTradeCount(), 2u);
    trade(4);
    EXPECT_EQ(core.retainedTradeCount(), 2u);
    EXPECT_EQ(replayedQtys(), (std::vector<engine::Quantity>{3, 4}));
}

TEST_F(EngineCoreTest, ObserverSeesEveryLiveEventButNoSnapshot) {
    RecordingOutput observer;
    core.setObserver(&observer);
    submit(1, kAlice, Side::Sell, 14'250, 30);
    submit(2, kBob, Side::Buy, 14'250, 10);
    cancel(3, kBob, 99);
    EXPECT_EQ(observer.messages, out.messages);
    EXPECT_EQ(observer.messages.size(), 5u);

    // With no gateway attached, the observer still gets the events.
    core.setOutput(nullptr);
    observer.messages.clear();
    cancel(4, kAlice, 1);
    ASSERT_EQ(observer.messages.size(), 1u);
    EXPECT_TRUE(std::holds_alternative<wire::OrderCancelled>(observer.messages.front()));

    observer.messages.clear();
    RecordingOutput snapshot;
    core.writeSnapshot(snapshot);
    EXPECT_FALSE(snapshot.messages.empty());
    EXPECT_TRUE(observer.messages.empty());
}

}  // namespace

#include <gtest/gtest.h>

#include <vector>

#include "Clock.h"
#include "EngineCore.h"
#include "InternalProtocol.h"

// EngineCore without sockets: decoded commands in, exact protocol events out.

namespace {

namespace wire = engine_service::protocol;
using engine::Side;
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
    EngineCore      core{clock};
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
                            .traderId = kAlice, .reason = wire::RejectCode::InvalidPrice},
        wire::OrderRejected{.eventSeq = 2, .ts = kT0, .clientTag = 2, .orderId = 0,
                            .traderId = kAlice, .reason = wire::RejectCode::InvalidQuantity},
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

}  // namespace

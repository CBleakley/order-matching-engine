#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <span>
#include <variant>
#include <vector>

#include "Clock.h"
#include "EngineCore.h"
#include "FrameDecoder.h"
#include "GatewaySession.h"
#include "InternalProtocol.h"

// GatewaySession without sockets: bytes in, bytes out.

namespace {

namespace wire = engine_service::protocol;
using Bytes = std::vector<std::uint8_t>;
using engine::Side;
using engine_service::CoreConfig;
using engine_service::EngineCore;
using engine_service::GatewaySession;
using engine_service::ManualClock;
using engine_service::SessionConfig;

constexpr wire::Timestamp kT0         = 1'792'252'800'000'000'000;
constexpr std::uint64_t   kInstanceId = 0xABCD'0123'4567'89EF;

template <class M>
Bytes frame(const M& message) {
    return wire::encode(message);
}

class GatewaySessionTest : public ::testing::Test {
protected:
    // Everything the session has queued for the gateway, decoded.
    std::vector<wire::EngineMessage> output() {
        const Bytes bytes = session->takeOutput();
        session->writeComplete(bytes.size());
        decoder.feed(bytes);
        std::vector<wire::EngineMessage> messages;
        for (;;) {
            auto result = decoder.next();
            if (std::holds_alternative<wire::NeedMoreData>(result)) break;
            if (std::holds_alternative<wire::ProtocolError>(result)) {
                ADD_FAILURE() << "session wrote an undecodable frame";
                break;
            }
            messages.push_back(std::get<wire::EngineMessage>(std::move(result)));
        }
        return messages;
    }

    void handshake() {
        session->onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion}));
        ASSERT_TRUE(session->handshakeComplete());
        output();
    }

    ManualClock clock{kT0};
    EngineCore  core{clock, CoreConfig{.minPriceTicks  = 1,
                                       .maxPriceTicks  = 100'000,
                                       .maxOrderQty    = 10'000,
                                       .tradeRetention = std::chrono::hours(24)}};
    int         notifications = 0;
    std::unique_ptr<GatewaySession> session = std::make_unique<GatewaySession>(
        core, clock, SessionConfig{.maxOutboundBytes = 1 << 20, .engineInstanceId = kInstanceId},
        [this] { ++notifications; });
    wire::FrameDecoder<wire::EngineMessage> decoder;
};

TEST_F(GatewaySessionTest, HelloIsAnsweredWithHelloAckAndASnapshot) {
    session->onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion}));
    EXPECT_TRUE(session->handshakeComplete());
    EXPECT_FALSE(session->closed());
    EXPECT_EQ(core.output(), session.get());
    EXPECT_GT(notifications, 0);

    EXPECT_EQ(output(), (std::vector<wire::EngineMessage>{
                            wire::HelloAck{.protocolVersion  = wire::kProtocolVersion,
                                           .engineInstanceId = kInstanceId,
                                           .serverTime       = kT0},
                            wire::SnapshotBegin{.eventSeq = 1},
                            wire::SnapshotEnd{.eventSeq = 1},
                        }));
}

TEST_F(GatewaySessionTest, HelloSplitAcrossReads) {
    const Bytes hello = frame(wire::Hello{.protocolVersion = wire::kProtocolVersion});
    for (const std::uint8_t byte : hello) {
        EXPECT_FALSE(session->handshakeComplete());
        session->onBytes(std::span(&byte, 1));
    }
    EXPECT_TRUE(session->handshakeComplete());
}

TEST_F(GatewaySessionTest, VersionMismatchCloses) {
    session->onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion + 1}));
    EXPECT_TRUE(session->closed());
    EXPECT_FALSE(session->handshakeComplete());
    EXPECT_NE(session->closeReason()->find("version"), std::string::npos);
    EXPECT_FALSE(session->hasOutput());
    EXPECT_EQ(core.output(), nullptr);
}

TEST_F(GatewaySessionTest, CommandBeforeHelloCloses) {
    session->onBytes(frame(wire::SubmitOrder{.clientTag = 1, .traderId = 1, .side = Side::Buy,
                                             .price = 100, .qty = 1}));
    EXPECT_TRUE(session->closed());
    EXPECT_EQ(core.nextOrderId(), 1u) << "the command must not reach the engine";
}

TEST_F(GatewaySessionTest, HeartbeatBeforeHelloCloses) {
    session->onBytes(frame(wire::GatewayHeartbeat{}));
    EXPECT_TRUE(session->closed());
}

TEST_F(GatewaySessionTest, SecondHelloCloses) {
    handshake();
    session->onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion}));
    EXPECT_TRUE(session->closed());
    EXPECT_EQ(core.output(), nullptr);
}

TEST_F(GatewaySessionTest, MalformedBytesClose) {
    handshake();
    session->onBytes(Bytes{0x00, 0x00, 0x00, 0x00});
    EXPECT_TRUE(session->closed());
    EXPECT_NE(session->closeReason()->find("frame-too-short"), std::string::npos);
}

TEST_F(GatewaySessionTest, CommandsReachTheCoreAndEventsComeBack) {
    handshake();
    Bytes bytes = frame(wire::SubmitOrder{.clientTag = 7, .traderId = 1'000'000,
                                          .side = Side::Sell, .price = 14'250, .qty = 10});
    const Bytes buy = frame(wire::SubmitOrder{.clientTag = 8, .traderId = 1'000'001,
                                              .side = Side::Buy, .price = 14'250, .qty = 10});
    const Bytes heartbeat = frame(wire::GatewayHeartbeat{});
    bytes.insert(bytes.end(), buy.begin(), buy.end());
    bytes.insert(bytes.end(), heartbeat.begin(), heartbeat.end());
    session->onBytes(bytes);

    EXPECT_FALSE(session->closed());
    const auto messages = output();
    ASSERT_EQ(messages.size(), 4u);  // accepted, rested, accepted, trade
    EXPECT_TRUE(std::holds_alternative<wire::OrderAccepted>(messages[0]));
    EXPECT_TRUE(std::holds_alternative<wire::OrderRested>(messages[1]));
    EXPECT_TRUE(std::holds_alternative<wire::OrderAccepted>(messages[2]));
    EXPECT_EQ(std::get<wire::Trade>(messages[3]).qty, 10);

    session->onBytes(frame(wire::CancelOrder{.clientTag = 9, .traderId = 1'000'000,
                                             .orderId = 1}));
    const auto cancel = output();
    ASSERT_EQ(cancel.size(), 1u);
    EXPECT_EQ(std::get<wire::OrderRejected>(cancel[0]).clientTag, 9u);
}

TEST_F(GatewaySessionTest, HeartbeatsOnlyAfterHandshake) {
    session->sendHeartbeat();
    EXPECT_FALSE(session->hasOutput());

    handshake();
    clock.advance(42);
    session->sendHeartbeat();
    const auto messages = output();
    ASSERT_EQ(messages.size(), 1u);
    EXPECT_EQ(messages[0], wire::EngineMessage(wire::EngineHeartbeat{.serverTime = kT0 + 42}));
}

TEST_F(GatewaySessionTest, OutboundLimitClosesASlowGateway) {
    session = std::make_unique<GatewaySession>(
        core, clock, SessionConfig{.maxOutboundBytes = 100, .engineInstanceId = 0});
    handshake();

    // Bytes taken by the writer but not yet written still count.
    session->sendHeartbeat();  // 13 bytes
    const Bytes inFlight = session->takeOutput();
    for (int i = 0; i < 6 && !session->closed(); ++i) session->sendHeartbeat();
    EXPECT_FALSE(session->closed()) << "13 in flight + 6 * 13 queued = 91 bytes";
    session->sendHeartbeat();
    EXPECT_TRUE(session->closed());
    EXPECT_FALSE(session->hasOutput());
    EXPECT_EQ(core.output(), nullptr);
}

TEST_F(GatewaySessionTest, CompletedWritesFreeTheLimit) {
    session = std::make_unique<GatewaySession>(
        core, clock, SessionConfig{.maxOutboundBytes = 30, .engineInstanceId = 0});
    handshake();
    for (int i = 0; i < 10; ++i) {
        session->sendHeartbeat();
        session->sendHeartbeat();
        const Bytes written = session->takeOutput();
        session->writeComplete(written.size());
    }
    EXPECT_FALSE(session->closed());
}

TEST_F(GatewaySessionTest, DestructionDetachesFromTheCore) {
    handshake();
    EXPECT_EQ(core.output(), session.get());
    session.reset();
    EXPECT_EQ(core.output(), nullptr);
}

TEST_F(GatewaySessionTest, SecondSessionCannotAttachWhileOneIsActive) {
    handshake();
    GatewaySession second(core, clock, SessionConfig{});
    second.onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion}));
    EXPECT_TRUE(second.closed());
    EXPECT_EQ(core.output(), session.get());
}

TEST_F(GatewaySessionTest, ReconnectSnapshotReflectsWhatHappenedWhileDisconnected) {
    using Messages = std::vector<wire::EngineMessage>;
    const auto submit = [](wire::ClientTag tag, engine::TraderId trader, Side side,
                           engine::Price price, engine::Quantity qty) {
        return wire::SubmitOrder{.clientTag = tag, .traderId = trader, .side = side,
                                 .price = price, .qty = qty};
    };

    handshake();
    session->onBytes(frame(submit(1, 1'000'000, Side::Sell, 200, 50)));  // order 1
    session->onBytes(frame(submit(2, 1'000'000, Side::Sell, 210, 10)));  // order 2
    ASSERT_EQ(output().size(), 4u);
    session.reset();  // disconnect mid-session
    ASSERT_EQ(core.output(), nullptr);

    // While no gateway is attached: a partial fill, a cancel and a new order.
    clock.advance(100);
    core.submit(submit(3, 1'000'001, Side::Buy, 200, 20));   // order 3: 20 of order 1
    core.cancel({.clientTag = 4, .traderId = 1'000'000, .orderId = 2});
    core.submit(submit(5, 1'000'001, Side::Buy, 190, 30));   // order 4: rests
    const wire::EventSeq next = core.nextEventSeq();
    ASSERT_EQ(next, 10u);  // 4 events before the disconnect, then 2 + 1 + 2 while disconnected

    session = std::make_unique<GatewaySession>(core, clock, SessionConfig{});
    session->onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion}));
    const Messages snapshot = output();
    ASSERT_FALSE(snapshot.empty());
    EXPECT_EQ(Messages(snapshot.begin() + 1, snapshot.end()), (Messages{
        wire::SnapshotBegin{.eventSeq = next},
        wire::RestingOrder{.orderId = 4, .traderId = 1'000'001, .side = Side::Buy, .price = 190,
                           .originalQty = 30, .remainingQty = 30, .acceptedAt = kT0 + 100},
        wire::RestingOrder{.orderId = 1, .traderId = 1'000'000, .side = Side::Sell, .price = 200,
                           .originalQty = 50, .remainingQty = 30, .acceptedAt = kT0},
        wire::TradeReplay{.eventSeq = 6, .ts = kT0 + 100, .makerOrderId = 1, .takerOrderId = 3,
                          .buyerTraderId = 1'000'001, .sellerTraderId = 1'000'000, .price = 200,
                          .qty = 20, .aggressorSide = Side::Buy},
        wire::SnapshotEnd{.eventSeq = next},
    }));

    // Live events continue from the advertised eventSeq, with no gap.
    session->onBytes(frame(wire::CancelOrder{.clientTag = 6, .traderId = 1'000'000,
                                             .orderId = 1}));
    EXPECT_EQ(output(), (Messages{
        wire::OrderCancelled{.eventSeq = next, .ts = kT0 + 100, .orderId = 1,
                             .traderId = 1'000'000, .cancelledQty = 30},
    }));
}

TEST_F(GatewaySessionTest, SnapshotIsExemptFromTheOutboundLimitUntilWritten) {
    // Enough retained trades for a snapshot far over the limit.
    for (wire::ClientTag i = 0; i < 20; ++i) {
        core.submit({.clientTag = i, .traderId = 1, .side = Side::Sell, .price = 100, .qty = 1});
        core.submit({.clientTag = i, .traderId = 2, .side = Side::Buy, .price = 100, .qty = 1});
    }
    session = std::make_unique<GatewaySession>(
        core, clock, SessionConfig{.maxOutboundBytes = 100, .engineInstanceId = 0});
    session->onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion}));
    EXPECT_FALSE(session->closed());

    // Events queued behind the unwritten snapshot get the normal limit on top.
    session->sendHeartbeat();  // 13 bytes
    EXPECT_FALSE(session->closed());

    Bytes snapshot = session->takeOutput();
    EXPECT_GT(snapshot.size(), 20u * 62u);
    session->writeComplete(snapshot.size());

    // Once the snapshot has been written, the plain limit applies again.
    for (int i = 0; i < 7; ++i) session->sendHeartbeat();
    EXPECT_FALSE(session->closed()) << "7 * 13 = 91 bytes";
    session->sendHeartbeat();
    EXPECT_TRUE(session->closed());
}

TEST_F(GatewaySessionTest, InputAfterCloseIsIgnored) {
    session->close("test");
    session->onBytes(frame(wire::Hello{.protocolVersion = wire::kProtocolVersion}));
    EXPECT_FALSE(session->handshakeComplete());
    EXPECT_EQ(*session->closeReason(), "test");
}

}  // namespace

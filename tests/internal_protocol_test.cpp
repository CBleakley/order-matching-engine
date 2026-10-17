#include <gtest/gtest.h>

#include <cstdint>
#include <variant>
#include <vector>

#include "FrameDecoder.h"
#include "InternalProtocol.h"
#include "InternalProtocolFixtures.h"

// Encoding and single-frame decoding against the shared byte fixtures.

namespace {

namespace wire = engine_service::protocol;
using protocol_fixtures::engineFixtures;
using protocol_fixtures::gatewayFixtures;

template <class Message>
void checkFixture(const protocol_fixtures::InternalFixture<Message>& fixture) {
    SCOPED_TRACE(fixture.name);
    const std::vector<std::uint8_t> bytes = fixture.bytes();

    std::vector<std::uint8_t> encoded;
    wire::encode(fixture.message, encoded);
    EXPECT_EQ(encoded, bytes);

    const std::size_t payload = std::visit(
        []<class M>(const M&) { return wire::payloadSize<M>(); }, fixture.message);
    EXPECT_EQ(bytes.size(), wire::kFrameHeaderSize + payload);

    const auto decoded = wire::decodeFrame<Message>(bytes);
    ASSERT_TRUE(std::holds_alternative<Message>(decoded))
        << wire::toString(std::get<wire::ProtocolError>(decoded));
    EXPECT_TRUE(std::get<Message>(decoded) == fixture.message);
}

TEST(InternalProtocol, GatewayMessagesMatchFixtures) {
    const auto fixtures = gatewayFixtures();
    ASSERT_EQ(fixtures.size(), std::variant_size_v<wire::GatewayMessage>);
    for (const auto& fixture : fixtures) checkFixture(fixture);
}

TEST(InternalProtocol, EngineMessagesMatchFixtures) {
    const auto fixtures = engineFixtures();
    ASSERT_EQ(fixtures.size(), std::variant_size_v<wire::EngineMessage>);
    for (const auto& fixture : fixtures) checkFixture(fixture);
}

TEST(InternalProtocol, EncodeAppendsToExistingBytes) {
    std::vector<std::uint8_t> out{0xAA};
    wire::encode(wire::GatewayHeartbeat{}, out);
    EXPECT_EQ(out, (std::vector<std::uint8_t>{0xAA, 0x01, 0x00, 0x00, 0x00, 0x04}));
}

TEST(InternalProtocol, EveryRejectCodeRoundTrips) {
    for (const auto reason : {wire::RejectCode::InvalidPrice, wire::RejectCode::InvalidQuantity,
                              wire::RejectCode::DuplicateOrderId, wire::RejectCode::UnknownOrderId,
                              wire::RejectCode::NotOwner, wire::RejectCode::PriceOutOfRange,
                              wire::RejectCode::QtyOutOfRange}) {
        const wire::EngineMessage message =
            wire::OrderRejected{.eventSeq = 1, .ts = 2, .clientTag = 3, .orderId = 0,
                                .traderId = 4, .reason = reason};
        const auto decoded = wire::decodeFrame<wire::EngineMessage>(wire::encode(message));
        ASSERT_TRUE(std::holds_alternative<wire::EngineMessage>(decoded));
        EXPECT_TRUE(std::get<wire::EngineMessage>(decoded) == message);
    }
}

TEST(InternalProtocol, RejectCodesExtendEngineReasons) {
    EXPECT_EQ(wire::toRejectCode(engine::RejectReason::InvalidPrice),
              wire::RejectCode::InvalidPrice);
    EXPECT_EQ(wire::toRejectCode(engine::RejectReason::InvalidQuantity),
              wire::RejectCode::InvalidQuantity);
    EXPECT_EQ(wire::toRejectCode(engine::RejectReason::DuplicateOrderId),
              wire::RejectCode::DuplicateOrderId);
    EXPECT_EQ(wire::toRejectCode(engine::RejectReason::UnknownOrderId),
              wire::RejectCode::UnknownOrderId);
}

TEST(InternalProtocol, DecodeFrameRejectsMessagesForTheOtherSide) {
    for (const auto& fixture : gatewayFixtures()) {
        EXPECT_EQ(std::get<wire::ProtocolError>(
                      wire::decodeFrame<wire::EngineMessage>(fixture.bytes())),
                  wire::ProtocolError::UnknownType)
            << fixture.name;
    }
    for (const auto& fixture : engineFixtures()) {
        EXPECT_EQ(std::get<wire::ProtocolError>(
                      wire::decodeFrame<wire::GatewayMessage>(fixture.bytes())),
                  wire::ProtocolError::UnknownType)
            << fixture.name;
    }
}

TEST(InternalProtocol, DecodeFrameRejectsTruncatedAndTrailingBytes) {
    std::vector<std::uint8_t> bytes = gatewayFixtures().at(1).bytes();  // submit-order
    std::vector<std::uint8_t> shorter(bytes.begin(), bytes.end() - 1);
    EXPECT_EQ(std::get<wire::ProtocolError>(wire::decodeFrame<wire::GatewayMessage>(shorter)),
              wire::ProtocolError::Truncated);

    bytes.push_back(0x00);
    EXPECT_EQ(std::get<wire::ProtocolError>(wire::decodeFrame<wire::GatewayMessage>(bytes)),
              wire::ProtocolError::LengthMismatch);

    EXPECT_EQ(std::get<wire::ProtocolError>(wire::decodeFrame<wire::GatewayMessage>({})),
              wire::ProtocolError::Truncated);
}

}  // namespace

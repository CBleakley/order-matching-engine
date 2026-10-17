#pragma once

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "InternalProtocol.h"
#include "ProtocolFixtures.h"

// The messages encoded in protocol/fixtures/internal/*.hex. The TypeScript
// tests (gateway/test/internal/fixtures.ts) hold the same values; the shared
// bytes are what keep the two codecs in agreement.

namespace protocol_fixtures {

namespace wire = engine_service::protocol;

template <class Message>
struct InternalFixture {
    std::string name;  // file name without .hex
    Message     message;

    std::vector<std::uint8_t> bytes() const { return readHex("fixtures/internal/" + name + ".hex"); }
};

constexpr std::uint64_t kU64Max = std::numeric_limits<std::uint64_t>::max();
constexpr std::int64_t  kI64Max = std::numeric_limits<std::int64_t>::max();
constexpr std::int64_t  kI64Min = std::numeric_limits<std::int64_t>::min();
constexpr std::uint32_t kU32Max = std::numeric_limits<std::uint32_t>::max();
constexpr std::int64_t  kTime   = 1'792'252'800'000'000'000;  // ns since the epoch

inline std::vector<InternalFixture<wire::GatewayMessage>> gatewayFixtures() {
    using engine::Side;
    return {
        {"hello", wire::Hello{.protocolVersion = 1}},
        {"submit-order", wire::SubmitOrder{.clientTag = kU64Max, .traderId = 1'000'000,
                                           .side = Side::Sell, .price = -14'250, .qty = kI64Max}},
        {"cancel-order", wire::CancelOrder{.clientTag = 42, .traderId = kU32Max,
                                           .orderId = kU64Max}},
        {"gateway-heartbeat", wire::GatewayHeartbeat{}},
    };
}

inline std::vector<InternalFixture<wire::EngineMessage>> engineFixtures() {
    using engine::Side;
    return {
        {"hello-ack", wire::HelloAck{.protocolVersion = 1,
                                     .engineInstanceId = 0x0123'4567'89AB'CDEF,
                                     .serverTime = kTime + 123'456'789}},
        {"snapshot-begin", wire::SnapshotBegin{.eventSeq = 1}},
        {"snapshot-end", wire::SnapshotEnd{.eventSeq = kU64Max}},
        {"resting-order", wire::RestingOrder{.orderId = 7, .traderId = 1'000'001,
                                             .side = Side::Buy, .price = 14'250,
                                             .originalQty = 100, .remainingQty = 40,
                                             .acceptedAt = -1}},
        {"trade-replay", wire::TradeReplay{.eventSeq = 12, .ts = kTime, .makerOrderId = 7,
                                           .takerOrderId = 9, .buyerTraderId = 1'000'001,
                                           .sellerTraderId = 3, .price = 14'251, .qty = 60,
                                           .aggressorSide = Side::Sell}},
        {"trade", wire::Trade{.eventSeq = std::uint64_t{1} << 63, .ts = kI64Max,
                              .makerOrderId = kU64Max, .takerOrderId = 1,
                              .buyerTraderId = kU32Max, .sellerTraderId = 0, .price = kI64Min,
                              .qty = 1, .aggressorSide = Side::Buy}},
        {"order-accepted", wire::OrderAccepted{.eventSeq = 2, .ts = kTime + 1,
                                               .clientTag = kU64Max, .orderId = 1,
                                               .traderId = 1'000'000, .side = Side::Buy,
                                               .price = 14'250, .qty = 10'000}},
        {"order-rejected", wire::OrderRejected{.eventSeq = 3, .ts = kTime + 2, .clientTag = 77,
                                               .orderId = 0, .traderId = 1'000'000,
                                               .reason = wire::RejectCode::NotOwner}},
        {"order-rested", wire::OrderRested{.eventSeq = 4, .ts = kTime + 3, .orderId = 1,
                                           .traderId = 999, .side = Side::Sell, .price = -1,
                                           .remainingQty = kI64Max}},
        {"order-cancelled", wire::OrderCancelled{.eventSeq = 5, .ts = kTime + 4, .orderId = 2,
                                                 .traderId = 1'000'002, .cancelledQty = 25}},
        {"engine-heartbeat", wire::EngineHeartbeat{.serverTime = kI64Min}},
    };
}

// Every fixture of one direction, concatenated in table order.
template <class Message>
std::vector<std::uint8_t> concatenated(const std::vector<InternalFixture<Message>>& fixtures) {
    std::vector<std::uint8_t> stream;
    for (const auto& fixture : fixtures) {
        const std::vector<std::uint8_t> bytes = fixture.bytes();
        stream.insert(stream.end(), bytes.begin(), bytes.end());
    }
    return stream;
}

}  // namespace protocol_fixtures

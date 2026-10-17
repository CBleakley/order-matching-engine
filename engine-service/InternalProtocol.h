#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string_view>
#include <type_traits>
#include <variant>
#include <vector>

#include "Types.h"

// Messages and codec for the private binary protocol between the gateway and
// the engine service. protocol/internal-protocol.md is the specification;
// gateway/src/internal/ holds the TypeScript codec, and both are tested
// against the byte fixtures in protocol/fixtures/internal/.
//
// Each message struct lists its fields once, in wire order, in a static
// `fields` function. Encoding, decoding and payload sizes are all derived
// from that list, so the three cannot disagree.

namespace engine_service::protocol {

constexpr std::uint16_t kProtocolVersion = 1;

// Largest accepted value of a frame's length field. Every current frame is
// far smaller; the cap bounds what a decoder buffers before rejecting a frame.
constexpr std::uint32_t kMaxFrameLength = 256;

// u32 length + u8 type.
constexpr std::size_t kFrameHeaderSize = 5;

using ClientTag = std::uint64_t;
using EventSeq  = std::uint64_t;
using Timestamp = std::int64_t;  // nanoseconds since the Unix epoch

enum class MessageType : std::uint8_t {
    // Gateway -> engine service.
    Hello            = 0x01,
    SubmitOrder      = 0x02,
    CancelOrder      = 0x03,
    GatewayHeartbeat = 0x04,
    // Engine service -> gateway.
    HelloAck         = 0x81,
    SnapshotBegin    = 0x82,
    SnapshotEnd      = 0x83,
    RestingOrder     = 0x84,
    TradeReplay      = 0x85,
    Trade            = 0x86,
    OrderAccepted    = 0x87,
    OrderRejected    = 0x88,
    OrderRested      = 0x89,
    OrderCancelled   = 0x8A,
    EngineHeartbeat  = 0x8B,
};

// Values 0-3 are the engine's own RejectReason values; 16 and up are added by
// the engine service.
enum class RejectCode : std::uint8_t {
    InvalidPrice     = 0,
    InvalidQuantity  = 1,
    DuplicateOrderId = 2,
    UnknownOrderId   = 3,
    NotOwner         = 16,
    PriceOutOfRange  = 17,
    QtyOutOfRange    = 18,
};

static_assert(static_cast<int>(engine::RejectReason::InvalidPrice) == 0);
static_assert(static_cast<int>(engine::RejectReason::InvalidQuantity) == 1);
static_assert(static_cast<int>(engine::RejectReason::DuplicateOrderId) == 2);
static_assert(static_cast<int>(engine::RejectReason::UnknownOrderId) == 3);
static_assert(static_cast<int>(engine::Side::Buy) == 0);
static_assert(static_cast<int>(engine::Side::Sell) == 1);

constexpr RejectCode toRejectCode(engine::RejectReason reason) noexcept {
    return static_cast<RejectCode>(reason);
}

// ---- Gateway -> engine service ---------------------------------------------

struct Hello {
    static constexpr MessageType kType = MessageType::Hello;
    std::uint16_t protocolVersion;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) { v(m.protocolVersion); }
    bool operator==(const Hello&) const = default;
};

struct SubmitOrder {
    static constexpr MessageType kType = MessageType::SubmitOrder;
    ClientTag        clientTag;
    engine::TraderId traderId;
    engine::Side     side;
    engine::Price    price;
    engine::Quantity qty;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.clientTag); v(m.traderId); v(m.side); v(m.price); v(m.qty);
    }
    bool operator==(const SubmitOrder&) const = default;
};

struct CancelOrder {
    static constexpr MessageType kType = MessageType::CancelOrder;
    ClientTag        clientTag;
    engine::TraderId traderId;
    engine::OrderId  orderId;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.clientTag); v(m.traderId); v(m.orderId);
    }
    bool operator==(const CancelOrder&) const = default;
};

struct GatewayHeartbeat {
    static constexpr MessageType kType = MessageType::GatewayHeartbeat;

    template <class Self, class Visitor>
    static constexpr void fields(Self&, Visitor&) {}
    bool operator==(const GatewayHeartbeat&) const = default;
};

// ---- Engine service -> gateway ---------------------------------------------

struct HelloAck {
    static constexpr MessageType kType = MessageType::HelloAck;
    std::uint16_t protocolVersion;
    std::uint64_t engineInstanceId;  // random per process start
    Timestamp     serverTime;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.protocolVersion); v(m.engineInstanceId); v(m.serverTime);
    }
    bool operator==(const HelloAck&) const = default;
};

struct SnapshotBegin {
    static constexpr MessageType kType = MessageType::SnapshotBegin;
    EventSeq eventSeq;  // the eventSeq at which live events resume

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) { v(m.eventSeq); }
    bool operator==(const SnapshotBegin&) const = default;
};

struct SnapshotEnd {
    static constexpr MessageType kType = MessageType::SnapshotEnd;
    EventSeq eventSeq;  // the eventSeq at which live events resume

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) { v(m.eventSeq); }
    bool operator==(const SnapshotEnd&) const = default;
};

struct RestingOrder {
    static constexpr MessageType kType = MessageType::RestingOrder;
    engine::OrderId  orderId;
    engine::TraderId traderId;
    engine::Side     side;
    engine::Price    price;
    engine::Quantity originalQty;
    engine::Quantity remainingQty;
    Timestamp        acceptedAt;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.orderId); v(m.traderId); v(m.side); v(m.price);
        v(m.originalQty); v(m.remainingQty); v(m.acceptedAt);
    }
    bool operator==(const RestingOrder&) const = default;
};

// Trade and TradeReplay share a layout.
template <class Self, class Visitor>
constexpr void tradeFields(Self& m, Visitor& v) {
    v(m.eventSeq); v(m.ts); v(m.makerOrderId); v(m.takerOrderId);
    v(m.buyerTraderId); v(m.sellerTraderId); v(m.price); v(m.qty); v(m.aggressorSide);
}

struct Trade {
    static constexpr MessageType kType = MessageType::Trade;
    EventSeq         eventSeq;
    Timestamp        ts;
    engine::OrderId  makerOrderId;
    engine::OrderId  takerOrderId;
    engine::TraderId buyerTraderId;
    engine::TraderId sellerTraderId;
    engine::Price    price;
    engine::Quantity qty;
    engine::Side     aggressorSide;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) { tradeFields(m, v); }
    bool operator==(const Trade&) const = default;
};

// A retained trade, sent only between SnapshotBegin and SnapshotEnd. It keeps
// the trade's original eventSeq and ts.
struct TradeReplay {
    static constexpr MessageType kType = MessageType::TradeReplay;
    EventSeq         eventSeq;
    Timestamp        ts;
    engine::OrderId  makerOrderId;
    engine::OrderId  takerOrderId;
    engine::TraderId buyerTraderId;
    engine::TraderId sellerTraderId;
    engine::Price    price;
    engine::Quantity qty;
    engine::Side     aggressorSide;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) { tradeFields(m, v); }
    bool operator==(const TradeReplay&) const = default;
};

struct OrderAccepted {
    static constexpr MessageType kType = MessageType::OrderAccepted;
    EventSeq         eventSeq;
    Timestamp        ts;
    ClientTag        clientTag;
    engine::OrderId  orderId;
    engine::TraderId traderId;
    engine::Side     side;
    engine::Price    price;
    engine::Quantity qty;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.eventSeq); v(m.ts); v(m.clientTag); v(m.orderId);
        v(m.traderId); v(m.side); v(m.price); v(m.qty);
    }
    bool operator==(const OrderAccepted&) const = default;
};

struct OrderRejected {
    static constexpr MessageType kType = MessageType::OrderRejected;
    EventSeq         eventSeq;
    Timestamp        ts;
    ClientTag        clientTag;
    engine::OrderId  orderId;  // 0 if the order was never assigned an ID
    engine::TraderId traderId;
    RejectCode       reason;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.eventSeq); v(m.ts); v(m.clientTag); v(m.orderId); v(m.traderId); v(m.reason);
    }
    bool operator==(const OrderRejected&) const = default;
};

struct OrderRested {
    static constexpr MessageType kType = MessageType::OrderRested;
    EventSeq         eventSeq;
    Timestamp        ts;
    engine::OrderId  orderId;
    engine::TraderId traderId;
    engine::Side     side;
    engine::Price    price;
    engine::Quantity remainingQty;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.eventSeq); v(m.ts); v(m.orderId); v(m.traderId);
        v(m.side); v(m.price); v(m.remainingQty);
    }
    bool operator==(const OrderRested&) const = default;
};

struct OrderCancelled {
    static constexpr MessageType kType = MessageType::OrderCancelled;
    EventSeq         eventSeq;
    Timestamp        ts;
    engine::OrderId  orderId;
    engine::TraderId traderId;
    engine::Quantity cancelledQty;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) {
        v(m.eventSeq); v(m.ts); v(m.orderId); v(m.traderId); v(m.cancelledQty);
    }
    bool operator==(const OrderCancelled&) const = default;
};

struct EngineHeartbeat {
    static constexpr MessageType kType = MessageType::EngineHeartbeat;
    Timestamp serverTime;

    template <class Self, class Visitor>
    static constexpr void fields(Self& m, Visitor& v) { v(m.serverTime); }
    bool operator==(const EngineHeartbeat&) const = default;
};

// Messages sent by the gateway (decoded by the engine service), and messages
// sent by the engine service (decoded by the gateway).
using GatewayMessage = std::variant<Hello, SubmitOrder, CancelOrder, GatewayHeartbeat>;
using EngineMessage  = std::variant<HelloAck, SnapshotBegin, SnapshotEnd, RestingOrder,
                                    TradeReplay, Trade, OrderAccepted, OrderRejected,
                                    OrderRested, OrderCancelled, EngineHeartbeat>;

// Reasons a byte stream is rejected. Any of them means the peer is broken or
// hostile, and the connection must be closed.
enum class ProtocolError : std::uint8_t {
    FrameTooShort,   // length 0: no room for the type byte
    FrameTooLarge,   // length above kMaxFrameLength
    UnknownType,     // not a message type the peer sends
    LengthMismatch,  // length disagrees with the type's fixed payload size
    InvalidEnum,     // a side or reject reason byte with no defined meaning
    Truncated,       // the input ended part way through a frame
};

constexpr std::string_view toString(ProtocolError error) noexcept {
    switch (error) {
        case ProtocolError::FrameTooShort:  return "frame-too-short";
        case ProtocolError::FrameTooLarge:  return "frame-too-large";
        case ProtocolError::UnknownType:    return "unknown-type";
        case ProtocolError::LengthMismatch: return "length-mismatch";
        case ProtocolError::InvalidEnum:    return "invalid-enum";
        case ProtocolError::Truncated:      return "truncated";
    }
    return "unknown";
}

namespace detail {

template <class T>
constexpr bool isValidEnum(std::uint8_t raw) noexcept {
    if constexpr (std::is_same_v<T, engine::Side>) {
        return raw <= 1;
    } else {
        static_assert(std::is_same_v<T, RejectCode>, "add validation for this enum");
        return raw <= 3 || (raw >= 16 && raw <= 18);
    }
}

struct SizeCounter {
    std::size_t size = 0;
    template <class T>
    constexpr void operator()(const T&) { size += sizeof(T); }
};

// Appends little-endian bytes, independent of the host's byte order.
struct Writer {
    std::vector<std::uint8_t>& out;

    void put(std::uint64_t value, std::size_t bytes) {
        for (std::size_t i = 0; i < bytes; ++i) {
            out.push_back(static_cast<std::uint8_t>(value >> (8 * i)));
        }
    }
    template <class T>
    void operator()(const T& value) {
        if constexpr (std::is_enum_v<T>) {
            put(static_cast<std::underlying_type_t<T>>(value), sizeof(T));
        } else {
            // Signed values become their two's complement bit pattern.
            put(static_cast<std::uint64_t>(value), sizeof(T));
        }
    }
};

// Reads little-endian bytes from a payload of exactly the right size.
struct Reader {
    std::span<const std::uint8_t> in;
    std::size_t pos = 0;
    bool validEnums = true;

    std::uint64_t take(std::size_t bytes) {
        std::uint64_t value = 0;
        for (std::size_t i = 0; i < bytes; ++i) {
            value |= static_cast<std::uint64_t>(in[pos + i]) << (8 * i);
        }
        pos += bytes;
        return value;
    }
    template <class T>
    void operator()(T& value) {
        const std::uint64_t raw = take(sizeof(T));
        if constexpr (std::is_enum_v<T>) {
            const auto byte = static_cast<std::uint8_t>(raw);
            validEnums = validEnums && isValidEnum<T>(byte);
            value = static_cast<T>(byte);
        } else {
            // Unsigned to signed conversion is modular in C++20.
            value = static_cast<T>(raw);
        }
    }
};

}  // namespace detail

template <class M>
constexpr std::size_t payloadSize() {
    M message{};
    detail::SizeCounter counter;
    M::fields(message, counter);
    return counter.size;
}

static_assert(payloadSize<Hello>() == 2);
static_assert(payloadSize<SubmitOrder>() == 29);
static_assert(payloadSize<CancelOrder>() == 20);
static_assert(payloadSize<GatewayHeartbeat>() == 0);
static_assert(payloadSize<HelloAck>() == 18);
static_assert(payloadSize<SnapshotBegin>() == 8);
static_assert(payloadSize<SnapshotEnd>() == 8);
static_assert(payloadSize<RestingOrder>() == 45);
static_assert(payloadSize<TradeReplay>() == 57);
static_assert(payloadSize<Trade>() == 57);
static_assert(payloadSize<OrderAccepted>() == 53);
static_assert(payloadSize<OrderRejected>() == 37);
static_assert(payloadSize<OrderRested>() == 45);
static_assert(payloadSize<OrderCancelled>() == 36);
static_assert(payloadSize<EngineHeartbeat>() == 8);

// Appends one complete frame (length, type, payload) to `out`.
template <class M>
void encode(const M& message, std::vector<std::uint8_t>& out) {
    detail::Writer writer{out};
    writer(static_cast<std::uint32_t>(1 + payloadSize<M>()));
    writer(M::kType);
    M::fields(message, writer);
}

template <class... Ms>
void encode(const std::variant<Ms...>& message, std::vector<std::uint8_t>& out) {
    std::visit([&out](const auto& m) { encode(m, out); }, message);
}

template <class M>
std::vector<std::uint8_t> encode(const M& message) {
    std::vector<std::uint8_t> out;
    encode(message, out);
    return out;
}

// Per-direction lookup and payload decoding over the alternatives of a
// message variant (GatewayMessage or EngineMessage).
template <class Variant>
struct MessageSet;

template <class... Ms>
struct MessageSet<std::variant<Ms...>> {
    using Message = std::variant<Ms...>;

    // The payload size for a type byte, or nullopt if the type is not in
    // this message set.
    static constexpr std::optional<std::size_t> payloadSizeFor(std::uint8_t type) {
        std::optional<std::size_t> size;
        static_cast<void>(((static_cast<std::uint8_t>(Ms::kType) == type
                                ? (size = payloadSize<Ms>(), true)
                                : false) || ...));
        return size;
    }

    // Decodes a payload whose type and size have already been checked.
    // Returns nullopt if an enum field holds an undefined value.
    static std::optional<Message> decodePayload(std::uint8_t type,
                                                std::span<const std::uint8_t> payload) {
        std::optional<Message> result;
        const auto tryDecode = [&]<class M>() {
            if (static_cast<std::uint8_t>(M::kType) != type) return false;
            M message{};
            detail::Reader reader{payload};
            M::fields(message, reader);
            if (reader.validEnums) result = message;
            return true;
        };
        static_cast<void>((tryDecode.template operator()<Ms>() || ...));
        return result;
    }
};

}  // namespace engine_service::protocol

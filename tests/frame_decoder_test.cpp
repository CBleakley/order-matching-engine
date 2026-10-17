#include <gtest/gtest.h>

#include <cstddef>
#include <cstdint>
#include <random>
#include <span>
#include <variant>
#include <vector>

#include "FrameDecoder.h"
#include "InternalProtocol.h"
#include "InternalProtocolFixtures.h"

// Streaming behaviour of FrameDecoder: arbitrary chunking, and malformed input.

namespace {

namespace wire = engine_service::protocol;
using Bytes = std::vector<std::uint8_t>;
using wire::EngineMessage;
using wire::GatewayMessage;
using wire::ProtocolError;

template <class Message>
std::vector<Message> messagesOf(
    const std::vector<protocol_fixtures::InternalFixture<Message>>& fixtures) {
    std::vector<Message> messages;
    for (const auto& fixture : fixtures) messages.push_back(fixture.message);
    return messages;
}

// Returns every message available now; fails the test on a protocol error.
template <class Message>
void drain(wire::FrameDecoder<Message>& decoder, std::vector<Message>& out) {
    for (;;) {
        wire::DecodeResult<Message> result = decoder.next();
        if (std::holds_alternative<wire::NeedMoreData>(result)) return;
        if (const auto* error = std::get_if<ProtocolError>(&result)) {
            FAIL() << "unexpected protocol error " << wire::toString(*error);
        }
        out.push_back(std::get<Message>(std::move(result)));
    }
}

template <class Message>
std::vector<Message> decodeInChunks(const Bytes& stream, std::size_t chunkSize) {
    wire::FrameDecoder<Message> decoder;
    std::vector<Message> messages;
    for (std::size_t pos = 0; pos < stream.size(); pos += chunkSize) {
        const std::size_t n = std::min(chunkSize, stream.size() - pos);
        decoder.feed(std::span(stream).subspan(pos, n));
        drain(decoder, messages);
    }
    EXPECT_EQ(decoder.finish(), std::nullopt);
    return messages;
}

template <class Message>
ProtocolError errorAfterFeeding(const Bytes& bytes) {
    wire::FrameDecoder<Message> decoder;
    decoder.feed(bytes);
    for (;;) {
        wire::DecodeResult<Message> result = decoder.next();
        if (const auto* error = std::get_if<ProtocolError>(&result)) return *error;
        if (std::holds_alternative<wire::NeedMoreData>(result)) {
            ADD_FAILURE() << "expected a protocol error, decoder wants more data";
            return ProtocolError::Truncated;
        }
    }
}

template <class Message>
void expectAllFixturesInAnyChunking(
    const std::vector<protocol_fixtures::InternalFixture<Message>>& fixtures) {
    const Bytes stream = protocol_fixtures::concatenated(fixtures);
    const std::vector<Message> expected = messagesOf(fixtures);

    EXPECT_TRUE(decodeInChunks<Message>(stream, stream.size()) == expected) << "one chunk";
    EXPECT_TRUE(decodeInChunks<Message>(stream, 1) == expected) << "one byte at a time";
    EXPECT_TRUE(decodeInChunks<Message>(stream, 7) == expected) << "7-byte chunks";

    // Two reads split at every offset, so every frame is split at every
    // position (including inside the length and at the type byte).
    for (std::size_t split = 0; split <= stream.size(); ++split) {
        wire::FrameDecoder<Message> decoder;
        std::vector<Message> messages;
        decoder.feed(std::span(stream).first(split));
        drain(decoder, messages);
        decoder.feed(std::span(stream).subspan(split));
        drain(decoder, messages);
        EXPECT_TRUE(messages == expected) << "split at " << split;
        EXPECT_EQ(decoder.finish(), std::nullopt) << "split at " << split;
    }
}

TEST(FrameDecoder, GatewayStreamDecodesInAnyChunking) {
    expectAllFixturesInAnyChunking(protocol_fixtures::gatewayFixtures());
}

TEST(FrameDecoder, EngineStreamDecodesInAnyChunking) {
    expectAllFixturesInAnyChunking(protocol_fixtures::engineFixtures());
}

TEST(FrameDecoder, RandomChunkSizes) {
    const auto fixtures = protocol_fixtures::engineFixtures();
    Bytes stream;
    std::vector<EngineMessage> expected;
    for (int repeat = 0; repeat < 20; ++repeat) {
        const Bytes once = protocol_fixtures::concatenated(fixtures);
        stream.insert(stream.end(), once.begin(), once.end());
        for (const auto& fixture : fixtures) expected.push_back(fixture.message);
    }
    std::mt19937_64 rng(12345);
    wire::FrameDecoder<EngineMessage> decoder;
    std::vector<EngineMessage> messages;
    for (std::size_t pos = 0; pos < stream.size();) {
        const std::size_t n = std::min<std::size_t>(1 + rng() % 200, stream.size() - pos);
        decoder.feed(std::span(stream).subspan(pos, n));
        drain(decoder, messages);
        pos += n;
    }
    EXPECT_TRUE(messages == expected);
    EXPECT_EQ(decoder.finish(), std::nullopt);
}

TEST(FrameDecoder, TruncatedFrameIsReportedByFinish) {
    const Bytes hello = protocol_fixtures::gatewayFixtures().at(0).bytes();
    for (std::size_t keep = 1; keep < hello.size(); ++keep) {
        wire::FrameDecoder<GatewayMessage> decoder;
        decoder.feed(std::span(hello).first(keep));
        EXPECT_TRUE(std::holds_alternative<wire::NeedMoreData>(decoder.next())) << keep;
        EXPECT_EQ(decoder.finish(), ProtocolError::Truncated) << keep;
    }
}

TEST(FrameDecoder, EmptyInputFinishesCleanly) {
    wire::FrameDecoder<GatewayMessage> decoder;
    EXPECT_TRUE(std::holds_alternative<wire::NeedMoreData>(decoder.next()));
    EXPECT_EQ(decoder.finish(), std::nullopt);
}

TEST(FrameDecoder, UnknownTypes) {
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>({0x01, 0x00, 0x00, 0x00, 0x00}),
              ProtocolError::UnknownType);
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>({0x01, 0x00, 0x00, 0x00, 0x7F}),
              ProtocolError::UnknownType);
    EXPECT_EQ(errorAfterFeeding<EngineMessage>({0x01, 0x00, 0x00, 0x00, 0xFF}),
              ProtocolError::UnknownType);
    // A valid engine -> gateway frame sent the wrong way.
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>(protocol_fixtures::engineFixtures().back().bytes()),
              ProtocolError::UnknownType);
}

TEST(FrameDecoder, LengthMismatchIsDetectedFromTheHeader) {
    // Hello has a 2-byte payload, so its length must be 3. Only the header is
    // sent: the mismatch is reported without waiting for the body.
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>({0x04, 0x00, 0x00, 0x00, 0x01}),
              ProtocolError::LengthMismatch);
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>({0x02, 0x00, 0x00, 0x00, 0x01}),
              ProtocolError::LengthMismatch);
    // Heartbeat has no payload; the largest permitted length is still wrong for it.
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>({0x00, 0x01, 0x00, 0x00, 0x04}),
              ProtocolError::LengthMismatch);
}

TEST(FrameDecoder, ZeroLength) {
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>({0x00, 0x00, 0x00, 0x00}),
              ProtocolError::FrameTooShort);
}

TEST(FrameDecoder, OversizedLengthIsRejectedAfterFourBytes) {
    static_assert(wire::kMaxFrameLength == 256);
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>({0x01, 0x01, 0x00, 0x00}),  // 257
              ProtocolError::FrameTooLarge);
    EXPECT_EQ(errorAfterFeeding<EngineMessage>({0xFF, 0xFF, 0xFF, 0xFF}),
              ProtocolError::FrameTooLarge);
}

TEST(FrameDecoder, InvalidEnumValues) {
    Bytes submit = protocol_fixtures::gatewayFixtures().at(1).bytes();
    constexpr std::size_t kSideOffset = wire::kFrameHeaderSize + 8 + 4;
    ASSERT_EQ(submit.at(kSideOffset), 1);  // Sell in the fixture
    submit[kSideOffset] = 2;
    EXPECT_EQ(errorAfterFeeding<GatewayMessage>(submit), ProtocolError::InvalidEnum);

    Bytes rejected = protocol_fixtures::engineFixtures().at(7).bytes();
    constexpr std::size_t kReasonOffset = wire::kFrameHeaderSize + 8 + 8 + 8 + 8 + 4;
    ASSERT_EQ(rejected.at(kReasonOffset), 16);  // NotOwner in the fixture
    for (const std::uint8_t bad : std::vector<std::uint8_t>{4, 15, 19, 255}) {
        rejected[kReasonOffset] = bad;
        EXPECT_EQ(errorAfterFeeding<EngineMessage>(rejected), ProtocolError::InvalidEnum)
            << int{bad};
    }
}

TEST(FrameDecoder, ValidFramesBeforeAnErrorAreDelivered) {
    Bytes stream = protocol_fixtures::gatewayFixtures().at(0).bytes();
    const Bytes garbage{0x01, 0x00, 0x00, 0x00, 0x99};
    stream.insert(stream.end(), garbage.begin(), garbage.end());

    wire::FrameDecoder<GatewayMessage> decoder;
    decoder.feed(stream);
    EXPECT_TRUE(std::holds_alternative<GatewayMessage>(decoder.next()));
    EXPECT_EQ(std::get<ProtocolError>(decoder.next()), ProtocolError::UnknownType);
}

TEST(FrameDecoder, ErrorsAreSticky) {
    wire::FrameDecoder<GatewayMessage> decoder;
    decoder.feed(Bytes{0x00, 0x00, 0x00, 0x00});
    EXPECT_EQ(std::get<ProtocolError>(decoder.next()), ProtocolError::FrameTooShort);

    decoder.feed(protocol_fixtures::gatewayFixtures().at(0).bytes());
    EXPECT_EQ(std::get<ProtocolError>(decoder.next()), ProtocolError::FrameTooShort);
    EXPECT_EQ(decoder.error(), ProtocolError::FrameTooShort);
    EXPECT_EQ(decoder.finish(), ProtocolError::FrameTooShort);
}

// Random bytes must only ever produce messages, NeedMoreData or an error:
// never a crash or out-of-bounds read (checked under the sanitizers).
TEST(FrameDecoder, RandomGarbageNeverCrashes) {
    std::mt19937_64 rng(2024);
    for (int round = 0; round < 500; ++round) {
        wire::FrameDecoder<EngineMessage> decoder;
        bool failed = false;
        for (int chunk = 0; chunk < 20 && !failed; ++chunk) {
            Bytes bytes(1 + rng() % 64);
            for (auto& b : bytes) b = static_cast<std::uint8_t>(rng());
            // Keep lengths small and types plausible half the time, so the
            // decoder gets past the header checks.
            if (bytes.size() >= 5 && rng() % 2 == 0) {
                bytes[0] = static_cast<std::uint8_t>(rng() % 60);
                bytes[1] = bytes[2] = bytes[3] = 0;
                bytes[4] = static_cast<std::uint8_t>(0x81 + rng() % 11);
            }
            decoder.feed(bytes);
            for (;;) {
                auto result = decoder.next();
                if (std::holds_alternative<wire::NeedMoreData>(result)) break;
                if (std::holds_alternative<ProtocolError>(result)) {
                    failed = true;
                    break;
                }
            }
        }
    }
}

}  // namespace

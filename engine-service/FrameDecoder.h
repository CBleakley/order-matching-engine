#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <variant>
#include <vector>

#include "InternalProtocol.h"

// Streaming decoder for the internal protocol. Bytes arrive in arbitrary
// chunks (a frame split across reads, or several frames in one read); feed()
// buffers them and next() returns complete messages one at a time.
//
// The first protocol error is sticky: the decoder returns it from then on and
// ignores further input, since the connection must be closed.

namespace engine_service::protocol {

struct NeedMoreData {
    bool operator==(const NeedMoreData&) const = default;
};

template <class Message>
using DecodeResult = std::variant<NeedMoreData, Message, ProtocolError>;

template <class Message>
class FrameDecoder {
public:
    void feed(std::span<const std::uint8_t> bytes) {
        if (error_) return;
        if (pos_ > 0) {  // drop consumed frames before growing the buffer
            buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(pos_));
            pos_ = 0;
        }
        buffer_.insert(buffer_.end(), bytes.begin(), bytes.end());
    }

    // The next complete message, NeedMoreData, or the protocol error. Header
    // problems are reported as soon as the header bytes arrive, without
    // waiting for the rest of the frame.
    DecodeResult<Message> next() {
        if (error_) return *error_;
        const std::size_t available = buffer_.size() - pos_;
        if (available < 4) return NeedMoreData{};

        const std::uint32_t length = readLength();
        if (length == 0) return fail(ProtocolError::FrameTooShort);
        if (length > kMaxFrameLength) return fail(ProtocolError::FrameTooLarge);
        if (available < kFrameHeaderSize) return NeedMoreData{};

        const std::uint8_t type = buffer_[pos_ + 4];
        const std::optional<std::size_t> size = Set::payloadSizeFor(type);
        if (!size) return fail(ProtocolError::UnknownType);
        if (length != 1 + *size) return fail(ProtocolError::LengthMismatch);
        if (available < 4 + length) return NeedMoreData{};

        const std::span<const std::uint8_t> payload(buffer_.data() + pos_ + kFrameHeaderSize,
                                                    *size);
        std::optional<Message> message = Set::decodePayload(type, payload);
        if (!message) return fail(ProtocolError::InvalidEnum);
        pos_ += 4 + length;
        return std::move(*message);
    }

    // True if buffered bytes do not yet form a complete frame (or frames
    // remain that next() has not returned).
    bool hasBufferedBytes() const noexcept { return pos_ < buffer_.size(); }

    // Call when the input has ended: reports Truncated if a frame was cut
    // short, or the earlier error if there was one.
    std::optional<ProtocolError> finish() {
        if (!error_ && hasBufferedBytes()) error_ = ProtocolError::Truncated;
        return error_;
    }

    std::optional<ProtocolError> error() const noexcept { return error_; }

private:
    using Set = MessageSet<Message>;

    std::uint32_t readLength() const {
        std::uint32_t length = 0;
        for (std::size_t i = 0; i < 4; ++i) {
            length |= static_cast<std::uint32_t>(buffer_[pos_ + i]) << (8 * i);
        }
        return length;
    }

    ProtocolError fail(ProtocolError error) {
        error_ = error;
        return error;
    }

    std::vector<std::uint8_t>   buffer_;
    std::size_t                 pos_ = 0;  // start of the first unconsumed frame
    std::optional<ProtocolError> error_;
};

// Decodes a buffer that must hold exactly one frame.
template <class Message>
std::variant<Message, ProtocolError> decodeFrame(std::span<const std::uint8_t> bytes) {
    FrameDecoder<Message> decoder;
    decoder.feed(bytes);
    DecodeResult<Message> result = decoder.next();
    if (auto* error = std::get_if<ProtocolError>(&result)) return *error;
    if (std::holds_alternative<NeedMoreData>(result)) return ProtocolError::Truncated;
    if (decoder.hasBufferedBytes()) return ProtocolError::LengthMismatch;
    return std::get<Message>(std::move(result));
}

}  // namespace engine_service::protocol

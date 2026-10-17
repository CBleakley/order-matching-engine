#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#include "Clock.h"
#include "EngineCore.h"
#include "FrameDecoder.h"
#include "InternalProtocol.h"

// The protocol state machine for one gateway connection, with no sockets:
// bytes in, bytes out. TcpServer moves bytes between it and the socket.
//
// The first frame must be a Hello with our protocol version; the session then
// replies HelloAck and attaches itself to the core as its event output. Any
// protocol violation closes the session: it records a reason, detaches, and
// ignores further input and output.

namespace engine_service {

struct SessionConfig {
    // Encoded bytes the session may hold (queued plus being written) before
    // it gives up on a gateway that is not reading.
    std::size_t   maxOutboundBytes = std::size_t{8} << 20;
    std::uint64_t engineInstanceId = 0;
};

class GatewaySession final : public EventOutput {
public:
    // `onOutput` is called whenever new bytes are queued or the session
    // closes, so the owner can schedule a write or tear the connection down.
    // It must not destroy the session synchronously.
    GatewaySession(EngineCore& core, Clock& clock, SessionConfig config,
                   std::function<void()> onOutput = {})
        : core_(core), clock_(clock), config_(config), onOutput_(std::move(onOutput)) {}

    ~GatewaySession() override { detach(); }

    GatewaySession(const GatewaySession&)            = delete;
    GatewaySession& operator=(const GatewaySession&) = delete;

    // Processes bytes received from the gateway.
    void onBytes(std::span<const std::uint8_t> bytes) {
        if (closed()) return;
        decoder_.feed(bytes);
        while (!closed()) {
            protocol::DecodeResult<protocol::GatewayMessage> result = decoder_.next();
            if (std::holds_alternative<protocol::NeedMoreData>(result)) return;
            if (const auto* error = std::get_if<protocol::ProtocolError>(&result)) {
                close("protocol error: " + std::string(protocol::toString(*error)));
                return;
            }
            handle(std::get<protocol::GatewayMessage>(result));
        }
    }

    void sendHeartbeat() {
        if (handshakeComplete_ && !closed()) {
            send(protocol::EngineHeartbeat{.serverTime = clock_.now()});
        }
    }

    // EventOutput: queues one message for the gateway.
    void send(const protocol::EngineMessage& message) override {
        if (closed()) return;
        protocol::encode(message, outbound_);
        if (outbound_.size() + inFlightBytes_ > config_.maxOutboundBytes) {
            close("gateway is not reading: outbound buffer over " +
                  std::to_string(config_.maxOutboundBytes) + " bytes");
            return;
        }
        notify();
    }

    // --- Writer side ---

    bool hasOutput() const noexcept { return !outbound_.empty(); }

    // Hands the queued bytes to the writer. They count against the outbound
    // limit until writeComplete().
    std::vector<std::uint8_t> takeOutput() {
        std::vector<std::uint8_t> bytes;
        bytes.swap(outbound_);
        inFlightBytes_ += bytes.size();
        return bytes;
    }

    void writeComplete(std::size_t bytes) noexcept {
        inFlightBytes_ -= bytes < inFlightBytes_ ? bytes : inFlightBytes_;
    }

    // --- State ---

    bool handshakeComplete() const noexcept { return handshakeComplete_; }
    bool closed() const noexcept { return closeReason_.has_value(); }
    const std::optional<std::string>& closeReason() const noexcept { return closeReason_; }

    // Closes the session (first reason wins) and detaches from the core.
    void close(std::string reason) {
        if (closed()) return;
        closeReason_ = std::move(reason);
        outbound_.clear();
        detach();
        notify();
    }

private:
    void handle(const protocol::GatewayMessage& message) {
        std::visit(
            [this]<class M>(const M& m) {
                if constexpr (std::is_same_v<M, protocol::Hello>) {
                    onHello(m);
                } else if (!handshakeComplete_) {
                    close("message before Hello");
                } else if constexpr (std::is_same_v<M, protocol::SubmitOrder>) {
                    core_.submit(m);
                } else if constexpr (std::is_same_v<M, protocol::CancelOrder>) {
                    core_.cancel(m);
                } else {
                    static_assert(std::is_same_v<M, protocol::GatewayHeartbeat>);
                    // Receiving anything resets the idle timer; nothing else to do.
                }
            },
            message);
    }

    void onHello(const protocol::Hello& hello) {
        if (handshakeComplete_) {
            close("duplicate Hello");
            return;
        }
        if (hello.protocolVersion != protocol::kProtocolVersion) {
            close("protocol version mismatch: gateway " + std::to_string(hello.protocolVersion) +
                  ", engine service " + std::to_string(protocol::kProtocolVersion));
            return;
        }
        if (core_.output() != nullptr) {
            close("another gateway is already attached");
            return;
        }
        handshakeComplete_ = true;
        send(protocol::HelloAck{.protocolVersion  = protocol::kProtocolVersion,
                                .engineInstanceId = config_.engineInstanceId,
                                .serverTime       = clock_.now()});
        core_.setOutput(this);
    }

    void detach() noexcept {
        if (core_.output() == this) core_.setOutput(nullptr);
    }

    void notify() {
        if (onOutput_) onOutput_();
    }

    EngineCore&           core_;
    Clock&                clock_;
    SessionConfig         config_;
    std::function<void()> onOutput_;

    protocol::FrameDecoder<protocol::GatewayMessage> decoder_;
    std::vector<std::uint8_t>                         outbound_;
    std::size_t                                       inFlightBytes_     = 0;
    bool                                              handshakeComplete_ = false;
    std::optional<std::string>                        closeReason_;
};

}  // namespace engine_service

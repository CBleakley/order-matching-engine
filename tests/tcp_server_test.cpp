#include <gtest/gtest.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <future>
#include <optional>
#include <sstream>
#include <thread>
#include <variant>
#include <vector>

#include <asio.hpp>

#include "Clock.h"
#include "EngineCore.h"
#include "FrameDecoder.h"
#include "InternalProtocol.h"
#include "Logger.h"
#include "TcpServer.h"

// End-to-end tests of the TCP server: the server runs on its own thread on an
// ephemeral port, and a test client talks to it with the C++ codec.

namespace {

namespace wire = engine_service::protocol;
using namespace std::chrono_literals;
using engine::Side;

constexpr wire::Timestamp kT0         = 1'792'252'800'000'000'000;
constexpr std::uint64_t   kInstanceId = 77;

// A blocking-style client whose every read is bounded by a deadline, so a
// broken server fails the test instead of hanging it.
class TestClient {
public:
    explicit TestClient(std::uint16_t port) {
        socket_.connect({asio::ip::make_address("127.0.0.1"), port});
    }

    template <class M>
    void send(const M& message) {
        const std::vector<std::uint8_t> bytes = wire::encode(message);
        asio::write(socket_, asio::buffer(bytes));
    }

    void sendRaw(const std::vector<std::uint8_t>& bytes) {
        asio::write(socket_, asio::buffer(bytes));
    }

    // Sends Hello and reads HelloAck and the snapshot. Returns the snapshot,
    // from SnapshotBegin to SnapshotEnd, or an empty vector on failure.
    std::vector<wire::EngineMessage> handshake(std::chrono::milliseconds timeout = 3s) {
        send(wire::Hello{.protocolVersion = wire::kProtocolVersion});
        const auto ack = receive(timeout);
        if (!ack || !std::holds_alternative<wire::HelloAck>(*ack)) return {};
        std::vector<wire::EngineMessage> snapshot;
        for (;;) {
            auto message = receive();
            if (!message) return {};
            snapshot.push_back(std::move(*message));
            if (std::holds_alternative<wire::SnapshotEnd>(snapshot.back())) return snapshot;
        }
    }

    // The next message other than a heartbeat, or nullopt if the connection
    // closed or nothing arrived in time.
    std::optional<wire::EngineMessage> receive(std::chrono::milliseconds timeout = 3s) {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        for (;;) {
            auto result = decoder_.next();
            if (auto* message = std::get_if<wire::EngineMessage>(&result)) {
                if (std::holds_alternative<wire::EngineHeartbeat>(*message)) {
                    ++heartbeats_;
                    continue;
                }
                return std::move(*message);
            }
            if (std::holds_alternative<wire::ProtocolError>(result)) {
                ADD_FAILURE() << "server sent an undecodable frame";
                return std::nullopt;
            }
            if (!readSome(deadline)) return std::nullopt;
        }
    }

    // True once the server closes the connection (before the timeout).
    bool waitForClose(std::chrono::milliseconds timeout = 3s) {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (readSome(deadline)) {
        }
        return closed_;
    }

    // Keeps the connection alive for `duration`, sending heartbeats, and
    // returns false if the server closed it.
    bool stayAlive(std::chrono::milliseconds duration, std::chrono::milliseconds every) {
        const auto end = std::chrono::steady_clock::now() + duration;
        while (std::chrono::steady_clock::now() < end) {
            send(wire::GatewayHeartbeat{});
            readSome(std::chrono::steady_clock::now() + every);
            if (closed_) return false;
            while (receiveHeartbeatsOnly()) {
            }
        }
        return true;
    }

    int  heartbeats() const noexcept { return heartbeats_; }
    bool closed() const noexcept { return closed_; }

private:
    bool receiveHeartbeatsOnly() {
        auto result = decoder_.next();
        if (auto* message = std::get_if<wire::EngineMessage>(&result)) {
            if (std::holds_alternative<wire::EngineHeartbeat>(*message)) ++heartbeats_;
            return true;
        }
        return false;
    }

    // Reads whatever arrives before the deadline into the decoder. Returns
    // false on timeout or once the connection has closed.
    bool readSome(std::chrono::steady_clock::time_point deadline) {
        if (closed_) return false;
        bool            done = false;
        std::error_code error;
        std::size_t     n = 0;
        socket_.async_read_some(asio::buffer(buffer_), [&](std::error_code ec, std::size_t k) {
            done  = true;
            error = ec;
            n     = k;
        });
        io_.restart();
        io_.run_until(deadline);
        if (!done) {  // timed out: cancel and let the handler run
            socket_.cancel();
            io_.restart();
            io_.run();
            return false;
        }
        if (error) {
            closed_ = true;
            return false;
        }
        decoder_.feed(std::span<const std::uint8_t>(buffer_.data(), n));
        return true;
    }

    asio::io_context                        io_;
    asio::ip::tcp::socket                   socket_{io_};
    std::array<std::uint8_t, 4096>          buffer_{};
    wire::FrameDecoder<wire::EngineMessage> decoder_;
    int                                     heartbeats_ = 0;
    bool                                    closed_     = false;
};

class TcpServerTest : public ::testing::Test {
protected:
    void SetUp() override {
        config.address           = "127.0.0.1";
        config.port              = 0;
        config.heartbeatInterval = 50ms;
        config.idleTimeout       = 400ms;
        config.engineInstanceId  = kInstanceId;
    }

    void startServer() {
        server.emplace(io, core, clock, log, config);
        server->start();
        thread = std::thread([this] { io.run(); });
    }

    void TearDown() override {
        if (!thread.joinable()) return;
        asio::post(io, [this] { server->stop(); });
        thread.join();
    }

    std::uint16_t port() const { return server->port(); }

    engine_service::ServerConfig                    config;
    engine_service::ManualClock                     clock{kT0};
    engine_service::EngineCore                      core{
        clock, engine_service::CoreConfig{.minPriceTicks  = 1,
                                          .maxPriceTicks  = 100'000,
                                          .maxOrderQty    = 10'000,
                                          .tradeRetention = std::chrono::hours(24)}};
    std::ostringstream                              logText;
    engine_service::Logger                          log{engine_service::LogLevel::Debug, logText};
    asio::io_context                                io;
    std::optional<engine_service::TcpServer>        server;
    std::thread                                     thread;
};

wire::SubmitOrder order(wire::ClientTag tag, engine::TraderId trader, Side side,
                        engine::Price price, engine::Quantity qty) {
    return {.clientTag = tag, .traderId = trader, .side = side, .price = price, .qty = qty};
}

TEST_F(TcpServerTest, HandshakeAndCrossingOrders) {
    startServer();
    TestClient client(port());

    client.send(wire::Hello{.protocolVersion = wire::kProtocolVersion});
    const auto ack = client.receive();
    ASSERT_TRUE(ack.has_value());
    EXPECT_EQ(*ack, wire::EngineMessage(wire::HelloAck{.protocolVersion  = wire::kProtocolVersion,
                                                       .engineInstanceId = kInstanceId,
                                                       .serverTime       = kT0}));
    const auto begin = client.receive();
    const auto end   = client.receive();
    ASSERT_TRUE(begin.has_value() && end.has_value());
    EXPECT_EQ(*begin, wire::EngineMessage(wire::SnapshotBegin{.eventSeq = 1}));
    EXPECT_EQ(*end, wire::EngineMessage(wire::SnapshotEnd{.eventSeq = 1}));

    client.send(order(1, 1'000'000, Side::Sell, 14'250, 10));
    client.send(order(2, 1'000'001, Side::Buy, 14'300, 25));

    std::vector<wire::EngineMessage> events;
    for (int i = 0; i < 5; ++i) {
        auto message = client.receive();
        ASSERT_TRUE(message.has_value()) << "event " << i;
        events.push_back(std::move(*message));
    }
    EXPECT_EQ(events, (std::vector<wire::EngineMessage>{
        wire::OrderAccepted{.eventSeq = 1, .ts = kT0, .clientTag = 1, .orderId = 1,
                            .traderId = 1'000'000, .side = Side::Sell, .price = 14'250,
                            .qty = 10},
        wire::OrderRested{.eventSeq = 2, .ts = kT0, .orderId = 1, .traderId = 1'000'000,
                          .side = Side::Sell, .price = 14'250, .remainingQty = 10},
        wire::OrderAccepted{.eventSeq = 3, .ts = kT0, .clientTag = 2, .orderId = 2,
                            .traderId = 1'000'001, .side = Side::Buy, .price = 14'300,
                            .qty = 25},
        wire::Trade{.eventSeq = 4, .ts = kT0, .makerOrderId = 1, .takerOrderId = 2,
                    .buyerTraderId = 1'000'001, .sellerTraderId = 1'000'000, .price = 14'250,
                    .qty = 10, .aggressorSide = Side::Buy},
        wire::OrderRested{.eventSeq = 5, .ts = kT0, .orderId = 2, .traderId = 1'000'001,
                          .side = Side::Buy, .price = 14'300, .remainingQty = 15},
    }));
}

TEST_F(TcpServerTest, BadVersionClosesTheConnection) {
    startServer();
    TestClient client(port());
    client.send(wire::Hello{.protocolVersion = wire::kProtocolVersion + 1});
    EXPECT_TRUE(client.waitForClose());
}

TEST_F(TcpServerTest, CommandBeforeHelloClosesTheConnection) {
    startServer();
    TestClient client(port());
    client.send(order(1, 1'000'000, Side::Buy, 100, 1));
    EXPECT_TRUE(client.waitForClose());
}

TEST_F(TcpServerTest, MalformedFrameClosesTheConnection) {
    startServer();
    TestClient client(port());
    ASSERT_FALSE(client.handshake().empty());
    client.sendRaw({0xFF, 0xFF, 0xFF, 0xFF});
    EXPECT_TRUE(client.waitForClose());
}

TEST_F(TcpServerTest, SecondConnectionIsRefusedWhileOneIsActive) {
    startServer();
    TestClient first(port());
    ASSERT_FALSE(first.handshake().empty());

    TestClient second(port());
    EXPECT_TRUE(second.waitForClose());

    // The first gateway is unaffected.
    first.send(order(1, 1'000'000, Side::Buy, 100, 1));
    const auto accepted = first.receive();
    ASSERT_TRUE(accepted.has_value());
    EXPECT_TRUE(std::holds_alternative<wire::OrderAccepted>(*accepted));
}

TEST_F(TcpServerTest, ServerSendsHeartbeatsAndAHeartbeatingClientStaysConnected) {
    startServer();
    TestClient client(port());
    ASSERT_FALSE(client.handshake().empty());
    EXPECT_TRUE(client.stayAlive(1000ms, 50ms));  // well past the 400 ms idle timeout
    EXPECT_GE(client.heartbeats(), 5);
}

TEST_F(TcpServerTest, SilentClientIsDroppedAfterTheIdleTimeout) {
    startServer();
    TestClient client(port());
    ASSERT_FALSE(client.handshake().empty());
    const auto start = std::chrono::steady_clock::now();
    EXPECT_TRUE(client.waitForClose(3s));
    EXPECT_GE(std::chrono::steady_clock::now() - start, 300ms);
}

TEST_F(TcpServerTest, ReconnectAfterDisconnect) {
    startServer();
    {
        TestClient client(port());
        ASSERT_FALSE(client.handshake().empty());
        client.send(order(1, 1'000'000, Side::Buy, 100, 1));  // eventSeq 1 and 2
        ASSERT_TRUE(client.receive().has_value());
        ASSERT_TRUE(client.receive().has_value());
    }  // client disconnects

    // An order arrives while no gateway is connected (eventSeq 3 and 4). The
    // core belongs to the server thread, so submit it there.
    std::promise<void> submitted;
    asio::post(io, [&] {
        core.submit(order(9, 1'000'001, Side::Sell, 200, 5));
        submitted.set_value();
    });
    submitted.get_future().wait();

    // The server notices the disconnect asynchronously; retry until it
    // accepts the new gateway rather than refusing it as a second one.
    for (int attempt = 0; attempt < 50; ++attempt) {
        TestClient client(port());
        const auto snapshot = client.handshake(500ms);
        if (snapshot.empty()) continue;

        EXPECT_EQ(snapshot, (std::vector<wire::EngineMessage>{
            wire::SnapshotBegin{.eventSeq = 5},
            wire::RestingOrder{.orderId = 1, .traderId = 1'000'000, .side = Side::Buy,
                               .price = 100, .originalQty = 1, .remainingQty = 1,
                               .acceptedAt = kT0},
            wire::RestingOrder{.orderId = 2, .traderId = 1'000'001, .side = Side::Sell,
                               .price = 200, .originalQty = 5, .remainingQty = 5,
                               .acceptedAt = kT0},
            wire::SnapshotEnd{.eventSeq = 5},
        }));

        client.send(order(2, 1'000'000, Side::Buy, 100, 1));
        const auto accepted = client.receive();
        ASSERT_TRUE(accepted.has_value());
        EXPECT_EQ(std::get<wire::OrderAccepted>(*accepted).eventSeq, 5u)
            << "live events continue from the snapshot's eventSeq";
        EXPECT_EQ(std::get<wire::OrderAccepted>(*accepted).orderId, 3u);
        return;
    }
    FAIL() << "the server never accepted a new gateway";
}

}  // namespace

#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include <asio.hpp>

#include "Clock.h"
#include "EngineCore.h"
#include "GatewaySession.h"
#include "Logger.h"

// Moves bytes between one gateway's TCP socket and a GatewaySession. All
// socket reads, writes and timers run on the io_context's single thread,
// which is also the thread that drives the EngineCore.
//
// Only one gateway is served at a time: a second connection is accepted and
// immediately closed. Once the active gateway disconnects, the next
// connection is served normally.

namespace engine_service {

struct ServerConfig {
    std::string               address           = "127.0.0.1";
    std::uint16_t             port              = 7001;  // 0 picks a free port
    std::chrono::milliseconds heartbeatInterval = std::chrono::seconds(1);
    std::chrono::milliseconds idleTimeout       = std::chrono::seconds(5);
    std::size_t               maxOutboundBytes  = std::size_t{8} << 20;
    std::uint64_t             engineInstanceId  = 0;
};

class TcpServer {
public:
    TcpServer(asio::io_context& io, EngineCore& core, Clock& clock, Logger& log,
              ServerConfig config)
        : io_(io), core_(core), clock_(clock), log_(log), config_(std::move(config)),
          acceptor_(io) {}

    TcpServer(const TcpServer&)            = delete;
    TcpServer& operator=(const TcpServer&) = delete;

    // Binds, listens and starts accepting. Throws std::system_error if the
    // address cannot be bound.
    void start() {
        const asio::ip::tcp::endpoint endpoint(asio::ip::make_address(config_.address),
                                               config_.port);
        acceptor_.open(endpoint.protocol());
#ifndef _WIN32
        // On Windows SO_REUSEADDR would let another process bind the same
        // port, so it is only set elsewhere (where it just skips TIME_WAIT).
        acceptor_.set_option(asio::ip::tcp::acceptor::reuse_address(true));
#endif
        acceptor_.bind(endpoint);
        acceptor_.listen();
        log_.info("listening on " + config_.address + ":" + std::to_string(port()));
        accept();
    }

    // The bound port (useful when configured with port 0).
    std::uint16_t port() const { return acceptor_.local_endpoint().port(); }

    // Stops accepting and closes the active connection. io_context::run()
    // returns once the cancelled operations have completed.
    void stop() {
        if (stopped_) return;
        stopped_ = true;
        std::error_code ignored;
        acceptor_.close(ignored);
        // close() releases active_, so hold a reference until it returns.
        if (const std::shared_ptr<Connection> connection = active_) {
            connection->close("server shutting down");
        }
    }

    bool hasActiveConnection() const noexcept { return active_ != nullptr; }

private:
    class Connection : public std::enable_shared_from_this<Connection> {
    public:
        Connection(TcpServer& server, asio::ip::tcp::socket socket, std::string peer)
            : server_(server), socket_(std::move(socket)), timer_(server.io_),
              peer_(std::move(peer)),
              session_(server.core_, server.clock_,
                       SessionConfig{.maxOutboundBytes = server.config_.maxOutboundBytes,
                                     .engineInstanceId = server.config_.engineInstanceId},
                       [this] { scheduleFlush(); }) {}

        void start() {
            lastReceived_ = std::chrono::steady_clock::now();
            read();
            armTimer();
        }

        void close(const std::string& reason) {
            if (closed_) return;
            closed_ = true;
            session_.close(reason);
            server_.log_.info("gateway " + peer_ + " disconnected: " + *session_.closeReason());
            timer_.cancel();
            std::error_code ignored;
            socket_.shutdown(asio::ip::tcp::socket::shutdown_both, ignored);
            socket_.close(ignored);
            server_.connectionClosed(this);
        }

    private:
        void read() {
            socket_.async_read_some(
                asio::buffer(readBuffer_),
                [self = shared_from_this()](std::error_code ec, std::size_t n) {
                    self->onRead(ec, n);
                });
        }

        void onRead(std::error_code ec, std::size_t n) {
            if (closed_) return;
            if (ec) {
                close(ec == asio::error::eof ? "connection closed by gateway" : ec.message());
                return;
            }
            lastReceived_ = std::chrono::steady_clock::now();
            const bool wasHandshaken = session_.handshakeComplete();
            session_.onBytes(std::span<const std::uint8_t>(readBuffer_.data(), n));
            if (session_.closed()) {
                close(*session_.closeReason());
                return;
            }
            if (!wasHandshaken && session_.handshakeComplete()) {
                server_.log_.info("gateway " + peer_ + " completed handshake");
            }
            flush();
            read();
        }

        // Called by the session whenever output is queued, possibly from deep
        // inside an EngineCore call: defer the work to a fresh handler.
        void scheduleFlush() {
            if (flushScheduled_ || closed_) return;
            flushScheduled_ = true;
            asio::post(server_.io_, [self = shared_from_this()] {
                self->flushScheduled_ = false;
                if (self->closed_) return;
                if (self->session_.closed()) {
                    self->close(*self->session_.closeReason());
                    return;
                }
                self->flush();
            });
        }

        void flush() {
            if (writing_ || closed_ || !session_.hasOutput()) return;
            writeBuffer_ = session_.takeOutput();
            writing_     = true;
            asio::async_write(socket_, asio::buffer(writeBuffer_),
                              [self = shared_from_this()](std::error_code ec, std::size_t n) {
                                  self->onWritten(ec, n);
                              });
        }

        void onWritten(std::error_code ec, std::size_t n) {
            writing_ = false;
            session_.writeComplete(n);
            if (closed_) return;
            if (ec) {
                close(ec.message());
                return;
            }
            flush();
        }

        void armTimer() {
            timer_.expires_after(server_.config_.heartbeatInterval);
            timer_.async_wait([self = shared_from_this()](std::error_code ec) {
                if (ec || self->closed_) return;
                self->onTimer();
            });
        }

        void onTimer() {
            const auto silent = std::chrono::steady_clock::now() - lastReceived_;
            if (silent > server_.config_.idleTimeout) {
                close("no data from gateway for " +
                      std::to_string(
                          std::chrono::duration_cast<std::chrono::milliseconds>(silent).count()) +
                      " ms");
                return;
            }
            session_.sendHeartbeat();
            flush();
            armTimer();
        }

        TcpServer&                            server_;
        asio::ip::tcp::socket                 socket_;
        asio::steady_timer                    timer_;
        std::string                           peer_;
        GatewaySession                        session_;
        std::array<std::uint8_t, 4096>        readBuffer_{};
        std::vector<std::uint8_t>             writeBuffer_;
        std::chrono::steady_clock::time_point lastReceived_{};
        bool                                  writing_        = false;
        bool                                  flushScheduled_ = false;
        bool                                  closed_         = false;
    };

    void accept() {
        acceptor_.async_accept([this](std::error_code ec, asio::ip::tcp::socket socket) {
            if (stopped_) return;
            if (ec) {
                log_.warn("accept failed: " + ec.message());
            } else {
                onAccepted(std::move(socket));
            }
            accept();
        });
    }

    void onAccepted(asio::ip::tcp::socket socket) {
        std::error_code ec;
        const auto remote = socket.remote_endpoint(ec);
        std::string peer = ec ? std::string("unknown peer")
                              : remote.address().to_string() + ":" + std::to_string(remote.port());
        if (active_) {
            log_.warn("refused connection from " + peer + ": a gateway is already connected");
            socket.shutdown(asio::ip::tcp::socket::shutdown_both, ec);
            socket.close(ec);
            return;
        }
        socket.set_option(asio::ip::tcp::no_delay(true), ec);
        log_.info("gateway connected from " + peer);
        active_ = std::make_shared<Connection>(*this, std::move(socket), std::move(peer));
        active_->start();
    }

    void connectionClosed(const Connection* connection) {
        if (active_.get() == connection) active_.reset();
    }

    asio::io_context&           io_;
    EngineCore&                 core_;
    Clock&                      clock_;
    Logger&                     log_;
    ServerConfig                config_;
    asio::ip::tcp::acceptor     acceptor_;
    std::shared_ptr<Connection> active_;
    bool                        stopped_ = false;
};

}  // namespace engine_service

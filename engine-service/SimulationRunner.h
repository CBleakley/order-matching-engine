#pragma once

#include <chrono>
#include <limits>
#include <system_error>

#include <asio.hpp>

#include "Clock.h"
#include "InternalProtocol.h"
#include "Simulator.h"

// Runs the simulator live, on the io_context's thread (the engine thread):
// a wall-clock timer fires when the next action is due, and every action that
// is due by then runs, with events stamped by the (wall) clock.

namespace engine_service {

class LiveSimulation {
public:
    LiveSimulation(asio::io_context& io, Simulator& simulator, Clock& clock)
        : simulator_(simulator), clock_(clock), timer_(io) {}

    LiveSimulation(const LiveSimulation&)            = delete;
    LiveSimulation& operator=(const LiveSimulation&) = delete;

    // The simulator must already be started (by warmUp, or start()).
    void start() {
        stopped_ = false;
        arm();
    }

    // Cancels the timer, so io_context::run() can return.
    void stop() {
        stopped_ = true;
        timer_.cancel();
    }

private:
    void arm() {
        const protocol::Timestamp next = simulator_.nextActionTime();
        if (next == std::numeric_limits<protocol::Timestamp>::max()) return;
        timer_.expires_at(std::chrono::system_clock::time_point(
            std::chrono::duration_cast<std::chrono::system_clock::duration>(
                std::chrono::nanoseconds(next))));
        timer_.async_wait([this](std::error_code ec) {
            if (ec || stopped_) return;
            simulator_.runDue(clock_.now());
            arm();
        });
    }

    Simulator&         simulator_;
    Clock&             clock_;
    asio::system_timer timer_;
    bool               stopped_ = false;
};

}  // namespace engine_service

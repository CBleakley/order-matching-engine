#pragma once

#include <chrono>

#include "InternalProtocol.h"

// The time source for event timestamps. Production uses the system clock;
// tests use ManualClock so timestamps are exact.

namespace engine_service {

class Clock {
public:
    virtual ~Clock() = default;
    // Nanoseconds since the Unix epoch.
    virtual protocol::Timestamp now() = 0;
};

class SystemClock final : public Clock {
public:
    protocol::Timestamp now() override {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(
                   std::chrono::system_clock::now().time_since_epoch())
            .count();
    }
};

class ManualClock final : public Clock {
public:
    explicit ManualClock(protocol::Timestamp start = 0) : now_(start) {}

    protocol::Timestamp now() override { return now_; }
    void set(protocol::Timestamp t) { now_ = t; }
    void advance(protocol::Timestamp delta) { now_ += delta; }

private:
    protocol::Timestamp now_;
};

// Reads a wall clock, or a pinned simulated time while one is set. The
// simulator's boot-time warm-up pins it to each action's time, then switches
// back to the wall clock.
class SwitchableClock final : public Clock {
public:
    explicit SwitchableClock(Clock& wall) : wall_(wall) {}

    protocol::Timestamp now() override { return simulated_ ? now_ : wall_.now(); }
    void setSimulated(protocol::Timestamp t) {
        now_       = t;
        simulated_ = true;
    }
    void useWall() { simulated_ = false; }
    bool isSimulated() const noexcept { return simulated_; }
    Clock& wall() noexcept { return wall_; }

private:
    Clock&              wall_;
    protocol::Timestamp now_       = 0;
    bool                simulated_ = false;
};

}  // namespace engine_service

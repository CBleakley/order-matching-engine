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

}  // namespace engine_service

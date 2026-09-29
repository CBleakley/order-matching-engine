#pragma once

#include <cstddef>
#include <ostream>
#include <variant>
#include <vector>

#include "Events.h"
#include "TypeStrings.h"

// Test helper: an EventSink that records every event it receives, in order,
// so tests can compare the engine's full output against an expected sequence.

namespace engine {

using Event = std::variant<OrderAccepted, OrderRejected, TradeEvent, OrderRested, OrderCancelled>;

class RecordingSink : public EventSink {
public:
    void onAccepted(const OrderAccepted& e) override { events_.emplace_back(e); }
    void onRejected(const OrderRejected& e) override { events_.emplace_back(e); }
    void onTrade(const TradeEvent& e) override { events_.emplace_back(e); }
    void onRested(const OrderRested& e) override { events_.emplace_back(e); }
    void onCancelled(const OrderCancelled& e) override { events_.emplace_back(e); }

    const std::vector<Event>& events() const noexcept { return events_; }
    std::size_t size() const noexcept { return events_.size(); }
    bool empty() const noexcept { return events_.empty(); }
    void clear() noexcept { events_.clear(); }

    friend bool operator==(const RecordingSink& lhs, const RecordingSink& rhs) {
        return lhs.events_ == rhs.events_;
    }

private:
    std::vector<Event> events_;
};

// Readable printers, used by GoogleTest in failure messages. They live in
// namespace engine so they are found by ADL.

inline std::ostream& operator<<(std::ostream& os, Side side) { return os << toString(side); }

inline std::ostream& operator<<(std::ostream& os, RejectReason reason) {
    return os << toString(reason);
}

inline std::ostream& operator<<(std::ostream& os, const OrderAccepted& e) {
    return os << "Accepted{id=" << e.id << ", seq=" << e.seq << '}';
}

inline std::ostream& operator<<(std::ostream& os, const OrderRejected& e) {
    return os << "Rejected{id=" << e.id << ", reason=" << e.reason << '}';
}

inline std::ostream& operator<<(std::ostream& os, const TradeEvent& e) {
    return os << "Trade{maker=" << e.makerId << ", taker=" << e.takerId << ", buyer=" << e.buyer
              << ", seller=" << e.seller << ", price=" << e.price << ", qty=" << e.qty
              << ", aggressor=" << e.aggressorSide << ", seq=" << e.seq << '}';
}

inline std::ostream& operator<<(std::ostream& os, const OrderRested& e) {
    return os << "Rested{id=" << e.id << ", side=" << e.side << ", price=" << e.price
              << ", qty=" << e.qty << '}';
}

inline std::ostream& operator<<(std::ostream& os, const OrderCancelled& e) {
    return os << "Cancelled{id=" << e.id << ", cancelledQty=" << e.cancelledQty << '}';
}

// GoogleTest prints std::variant via its own printer; this is for direct use
// and for printing a whole RecordingSink.
inline void printEvent(std::ostream& os, const Event& event) {
    std::visit([&os](const auto& e) { os << e; }, event);
}

inline std::ostream& operator<<(std::ostream& os, const RecordingSink& sink) {
    os << "RecordingSink[" << sink.size() << " event(s)]";
    for (std::size_t i = 0; i < sink.size(); ++i) {
        os << "\n  [" << i << "] ";
        printEvent(os, sink.events()[i]);
    }
    return os;
}

}  // namespace engine

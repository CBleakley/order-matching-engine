#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <ostream>
#include <sstream>
#include <string>
#include <variant>
#include <vector>

#include "EnumPrinters.h"
#include "OrderBook.h"
#include "RandomOrderFlow.h"
#include "RecordingSink.h"
#include "ReferenceOrderBook.h"

// Runs the same random order flow through engine::OrderBook and the naive
// ReferenceOrderBook and reports the first point at which they disagree.

namespace engine {

// Forwards every event to two sinks.
class TeeSink : public EventSink {
public:
    TeeSink(EventSink& a, EventSink& b) : a_(a), b_(b) {}

    void onAccepted(const OrderAccepted& e) override { a_.onAccepted(e); b_.onAccepted(e); }
    void onRejected(const OrderRejected& e) override { a_.onRejected(e); b_.onRejected(e); }
    void onTrade(const TradeEvent& e) override { a_.onTrade(e); b_.onTrade(e); }
    void onRested(const OrderRested& e) override { a_.onRested(e); b_.onRested(e); }
    void onCancelled(const OrderCancelled& e) override { a_.onCancelled(e); b_.onCancelled(e); }

private:
    EventSink& a_;
    EventSink& b_;
};

inline std::ostream& operator<<(std::ostream& os, const flow::Operation& op) {
    if (const auto* s = std::get_if<flow::SubmitOp>(&op)) {
        return os << "submit(id=" << s->id << ", trader=" << s->trader << ", side=" << s->side
                  << ", price=" << s->price << ", qty=" << s->qty << ')';
    }
    return os << "cancel(id=" << std::get<flow::CancelOp>(op).id << ')';
}

namespace detail {

inline void printEvents(std::ostream& os, const char* label, const std::vector<Event>& events) {
    os << "  " << label << " (" << events.size() << " event(s)):\n";
    for (const Event& e : events) {
        os << "    ";
        printEvent(os, e);
        os << '\n';
    }
}

inline void printOptionalPrice(std::ostream& os, const std::optional<Price>& p) {
    if (p) {
        os << *p;
    } else {
        os << "none";
    }
}

}  // namespace detail

// Runs `config.operations` operations from `seed` through both engines.
// Returns nullopt if they agree throughout, otherwise a report of the first
// operation at which their events or visible state differ. `rerunHint` is
// appended to the report to say how to reproduce the failure.
inline std::optional<std::string> runDifferential(std::uint64_t seed,
                                                  const flow::OrderFlowConfig& config,
                                                  const std::string& rerunHint = "") {
    flow::RandomOrderFlow gen(seed, config);

    RecordingSink realEvents;
    TeeSink       realSink(realEvents, gen);  // the generator tracks resting orders
    OrderBook     real(realSink);

    RecordingSink      refEvents;
    ReferenceOrderBook ref(refEvents);

    for (std::size_t i = 0; i < config.operations; ++i) {
        const flow::Operation op = gen.next();
        flow::RandomOrderFlow::apply(real, op);
        flow::RandomOrderFlow::apply(ref, op);

        const bool eventsMatch = realEvents.events() == refEvents.events();
        const bool stateMatches = real.orderCount() == ref.orderCount() &&
                                  real.bestBid() == ref.bestBid() &&
                                  real.bestAsk() == ref.bestAsk();

        if (!eventsMatch || !stateMatches) {
            std::ostringstream report;
            report << "Engines diverged: seed " << seed << ", operation " << i << ": " << op
                   << '\n';

            if (!eventsMatch) {
                const auto& a = realEvents.events();
                const auto& b = refEvents.events();
                std::size_t first = 0;
                while (first < a.size() && first < b.size() && a[first] == b[first]) ++first;
                report << "  first differing event is #" << first << " of this operation:\n";
                report << "    engine:    ";
                if (first < a.size()) printEvent(report, a[first]); else report << "(none)";
                report << "\n    reference: ";
                if (first < b.size()) printEvent(report, b[first]); else report << "(none)";
                report << '\n';
                detail::printEvents(report, "engine", a);
                detail::printEvents(report, "reference", b);
            } else {
                report << "  events match, but book state differs:\n"
                       << "    orderCount: engine " << real.orderCount() << ", reference "
                       << ref.orderCount() << "\n    bestBid: engine ";
                detail::printOptionalPrice(report, real.bestBid());
                report << ", reference ";
                detail::printOptionalPrice(report, ref.bestBid());
                report << "\n    bestAsk: engine ";
                detail::printOptionalPrice(report, real.bestAsk());
                report << ", reference ";
                detail::printOptionalPrice(report, ref.bestAsk());
                report << '\n';
            }

            if (!rerunHint.empty()) report << rerunHint << '\n';
            return report.str();
        }

        realEvents.clear();
        refEvents.clear();
    }
    return std::nullopt;
}

// The seed from the DIFF_SEED environment variable, if set, for rerunning a
// single failing seed.
inline std::optional<std::uint64_t> seedOverride() {
    const char* value = std::getenv("DIFF_SEED");
    if (value == nullptr || *value == '\0') return std::nullopt;
    return std::strtoull(value, nullptr, 10);
}

}  // namespace engine

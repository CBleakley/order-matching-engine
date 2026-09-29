#pragma once

#include <ostream>
#include <string>
#include <unordered_map>
#include <vector>
#include "Events.h"
#include "ioHelpers.h"
#include "OrderBook.h"
#include "TypeStrings.h"

// Minimal glue between text input and the engine: maps trader names to
// TraderIds, assigns order IDs, and prints engine events. To be replaced in
// P0-07.

class TraderRegistry {
public:
    engine::TraderId idFor(const std::string& name) {
        auto [it, inserted] = ids_.try_emplace(name, static_cast<engine::TraderId>(names_.size()));
        if (inserted) names_.push_back(name);
        return it->second;
    }

    const std::string& nameOf(engine::TraderId id) const { return names_.at(id); }

private:
    std::unordered_map<std::string, engine::TraderId> ids_;
    std::vector<std::string> names_;
};

class PrintingSink : public engine::EventSink {
public:
    PrintingSink(std::ostream& out, const TraderRegistry& traders) : out_(out), traders_(traders) {}

    void onAccepted(const engine::OrderAccepted& e) override {
        out_ << "Order " << e.id << " accepted (seq=" << e.seq << ")\n";
    }

    void onRejected(const engine::OrderRejected& e) override {
        out_ << "Order " << e.id << " rejected: " << engine::toString(e.reason) << '\n';
    }

    void onTrade(const engine::TradeEvent& e) override {
        out_ << "Trade executed: price=" << e.price << ", quantity=" << e.qty
             << ", buyer=" << traders_.nameOf(e.buyer) << ", seller=" << traders_.nameOf(e.seller)
             << '\n';
    }

    void onRested(const engine::OrderRested& e) override {
        out_ << "Order " << e.id << " rested: " << engine::toString(e.side) << ' ' << e.qty
             << " @ " << e.price << '\n';
    }

    void onCancelled(const engine::OrderCancelled& e) override {
        out_ << "Order " << e.id << " cancelled (" << e.cancelledQty << ")\n";
    }

private:
    std::ostream& out_;
    const TraderRegistry& traders_;
};

class CliSession {
public:
    explicit CliSession(std::ostream& out) : sink_(out, traders_), book_(sink_) {}

    // Parses one line of input and submits it; throws std::runtime_error on
    // malformed input.
    void handleInput(const std::string& input) {
        const ParsedOrder order = parseInput(input);
        book_.submit(nextOrderId_++, traders_.idFor(order.traderName), order.side, order.price,
                     order.quantity);
    }

private:
    TraderRegistry    traders_;
    PrintingSink      sink_;
    engine::OrderBook book_;
    engine::OrderId   nextOrderId_ = 1;
};

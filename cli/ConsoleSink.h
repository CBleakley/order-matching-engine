#pragma once

#include <cstddef>
#include <ostream>
#include <vector>

#include "Events.h"
#include "TraderRegistry.h"
#include "TypeStrings.h"

// Fixed-capacity ring buffer holding the most recent trades. Storage is
// allocated once, on construction.
class TradeHistory {
public:
    explicit TradeHistory(std::size_t capacity) : trades_(capacity) {}

    void push(const engine::TradeEvent& trade) {
        if (trades_.empty()) return;
        trades_[next_] = trade;
        next_          = (next_ + 1) % trades_.size();
        if (size_ < trades_.size()) ++size_;
    }

    std::size_t size() const noexcept { return size_; }
    std::size_t capacity() const noexcept { return trades_.size(); }

    // Calls fn(const TradeEvent&) for each stored trade, oldest first.
    template <typename Fn>
    void forEach(Fn&& fn) const {
        const std::size_t cap   = trades_.size();
        const std::size_t first = (next_ + cap - size_) % (cap == 0 ? 1 : cap);
        for (std::size_t i = 0; i < size_; ++i) fn(trades_[(first + i) % cap]);
    }

private:
    std::vector<engine::TradeEvent> trades_;
    std::size_t next_ = 0;  // slot the next trade is written to
    std::size_t size_ = 0;
};

// Prints engine events as they happen and remembers the last few trades.
class ConsoleSink : public engine::EventSink {
public:
    ConsoleSink(std::ostream& out, const TraderRegistry& traders, std::size_t tradeHistory = 5)
        : out_(out), traders_(traders), history_(tradeHistory) {}

    void onAccepted(const engine::OrderAccepted& e) override {
        out_ << "Order " << e.id << " accepted\n";
    }

    void onRejected(const engine::OrderRejected& e) override {
        out_ << "Order " << e.id << " rejected: " << engine::toString(e.reason) << '\n';
    }

    void onTrade(const engine::TradeEvent& e) override {
        out_ << "Trade: ";
        printTrade(e);
        history_.push(e);
    }

    void onRested(const engine::OrderRested& e) override {
        out_ << "Order " << e.id << " rested: " << engine::toString(e.side) << ' ' << e.qty
             << " @ " << e.price << '\n';
    }

    void onCancelled(const engine::OrderCancelled& e) override {
        out_ << "Order " << e.id << " cancelled (" << e.cancelledQty << " remaining)\n";
    }

    void printRecentTrades() const {
        if (history_.size() == 0) {
            out_ << "No trades yet\n";
            return;
        }
        out_ << "Last " << history_.size() << " trade(s), oldest first:\n";
        history_.forEach([this](const engine::TradeEvent& e) {
            out_ << "  ";
            printTrade(e);
        });
    }

    const TradeHistory& history() const noexcept { return history_; }

private:
    void printTrade(const engine::TradeEvent& e) const {
        out_ << e.qty << " @ " << e.price << ", buyer=" << traders_.nameOf(e.buyer)
             << ", seller=" << traders_.nameOf(e.seller) << " (maker #" << e.makerId
             << ", taker #" << e.takerId << ")\n";
    }

    std::ostream&         out_;
    const TraderRegistry& traders_;
    TradeHistory          history_;
};

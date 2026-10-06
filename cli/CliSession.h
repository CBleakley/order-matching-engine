#pragma once

#include <cstddef>
#include <iomanip>
#include <ostream>
#include <string_view>
#include <vector>

#include "CommandParser.h"
#include "ConsoleSink.h"
#include "OrderBook.h"
#include "TraderRegistry.h"

// Executes CLI commands against an order book. Owns the book, the trader
// name registry and the sink that prints events; assigns order IDs.
class CliSession {
public:
    explicit CliSession(std::ostream& out, std::size_t tradeHistory = 5)
        : out_(out), sink_(out, traders_, tradeHistory), book_(sink_) {}

    // Runs one line of input. Malformed input prints an error and is
    // otherwise ignored. Returns false if the user asked to quit.
    bool execute(std::string_view line) {
        try {
            return std::visit([this](const auto& command) { return run(command); },
                              commands::parseCommand(line));
        } catch (const commands::CommandError& e) {
            out_ << "error: " << e.what() << '\n';
            return true;
        }
    }

private:
    bool run(const commands::Order& c) {
        book_.submit(nextOrderId_++, traders_.idFor(c.trader), c.side, c.price, c.qty);
        return true;
    }

    bool run(const commands::Cancel& c) {
        book_.cancel(c.id);
        return true;
    }

    bool run(const commands::Book& c) {
        printBook(c.levels);
        return true;
    }

    bool run(const commands::Trades&) {
        sink_.printRecentTrades();
        return true;
    }

    bool run(const commands::Help&) {
        out_ << commands::kHelpText;
        return true;
    }

    bool run(const commands::Quit&) { return false; }
    bool run(const commands::Empty&) { return true; }

    // Prints asks above bids, each best price nearest the middle, with every
    // order at each level in time priority.
    void printBook(std::size_t levels) {
        book_.depth(engine::Side::Sell, levels, asks_);
        book_.depth(engine::Side::Buy, levels, bids_);
        if (asks_.empty() && bids_.empty()) {
            out_ << "Book is empty\n";
            return;
        }

        if (asks_.empty()) out_ << "  (no asks)\n";
        for (auto it = asks_.rbegin(); it != asks_.rend(); ++it) printLevel(engine::Side::Sell, *it);
        out_ << "  --------\n";
        for (const auto& level : bids_) printLevel(engine::Side::Buy, level);
        if (bids_.empty()) out_ << "  (no bids)\n";
    }

    void printLevel(engine::Side side, const engine::OrderBook::LevelView& level) {
        out_ << (side == engine::Side::Buy ? "  BID " : "  ASK ") << std::setw(6) << level.price
             << "  qty " << std::setw(6) << level.totalQty << "  ("
             << level.orderCount << (level.orderCount == 1 ? " order)  " : " orders) ");

        std::string_view separator = "";
        book_.forEachOrder(side, level.price, [&](const engine::Order& order) {
            out_ << separator << '#' << order.id << ' ' << traders_.nameOf(order.trader) << ' '
                 << order.remaining;
            separator = ", ";
        });
        out_ << '\n';
    }

    std::ostream&     out_;
    TraderRegistry    traders_;
    ConsoleSink       sink_;
    engine::OrderBook book_;
    engine::OrderId   nextOrderId_ = 1;

    // Reused across `book` commands.
    std::vector<engine::OrderBook::LevelView> asks_;
    std::vector<engine::OrderBook::LevelView> bids_;
};

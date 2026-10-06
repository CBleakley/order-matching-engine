#pragma once

#include <cctype>
#include <charconv>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <variant>
#include <vector>

#include "Types.h"

// Parses one line of CLI input into a command. Throws CommandError, with a
// message suitable for showing to the user, if the line is malformed.

namespace commands {

struct Order {
    engine::Side     side;
    std::string      trader;
    engine::Quantity qty;
    engine::Price    price;
};
struct Cancel { engine::OrderId id; };
struct Book { std::size_t levels; };
struct Trades {};
struct Help {};
struct Quit {};
struct Empty {};  // blank line

using Command = std::variant<Order, Cancel, Book, Trades, Help, Quit, Empty>;

constexpr std::size_t kDefaultBookLevels = 10;

constexpr std::string_view kHelpText =
    "Commands:\n"
    "  buy <trader> <qty> <price>   submit a buy order\n"
    "  sell <trader> <qty> <price>  submit a sell order\n"
    "  cancel <orderId>             cancel a resting order\n"
    "  book [levels]                show the book (default 10 levels per side)\n"
    "  trades                       show the most recent trades\n"
    "  help                         show this message\n"
    "  quit                         exit\n";

class CommandError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

inline std::vector<std::string_view> tokenize(std::string_view line) {
    std::vector<std::string_view> tokens;
    std::size_t i = 0;
    while (i < line.size()) {
        while (i < line.size() && std::isspace(static_cast<unsigned char>(line[i]))) ++i;
        const std::size_t start = i;
        while (i < line.size() && !std::isspace(static_cast<unsigned char>(line[i]))) ++i;
        if (i > start) tokens.push_back(line.substr(start, i - start));
    }
    return tokens;
}

inline std::string toLower(std::string_view s) {
    std::string out(s);
    for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}

// Parses a whole token as an integer of type T; `what` names it in errors.
template <typename T>
T parseNumber(std::string_view token, std::string_view what) {
    T value{};
    const auto [ptr, ec] = std::from_chars(token.data(), token.data() + token.size(), value);
    if (ec == std::errc::result_out_of_range) {
        throw CommandError(std::string(what) + " '" + std::string(token) + "' is out of range");
    }
    if (ec != std::errc{} || ptr != token.data() + token.size()) {
        throw CommandError("invalid " + std::string(what) + " '" + std::string(token) + "'");
    }
    return value;
}

inline Command parseCommand(std::string_view line) {
    const std::vector<std::string_view> tokens = tokenize(line);
    if (tokens.empty()) return Empty{};

    const std::string keyword = toLower(tokens[0]);
    const std::size_t nArgs   = tokens.size() - 1;

    if (keyword == "buy" || keyword == "sell") {
        if (nArgs != 3) throw CommandError("expected: " + keyword + " <trader> <qty> <price>");
        return Order{
            .side   = keyword == "buy" ? engine::Side::Buy : engine::Side::Sell,
            .trader = std::string(tokens[1]),
            .qty    = parseNumber<engine::Quantity>(tokens[2], "quantity"),
            .price  = parseNumber<engine::Price>(tokens[3], "price"),
        };
    }
    if (keyword == "cancel") {
        if (nArgs != 1) throw CommandError("expected: cancel <orderId>");
        return Cancel{parseNumber<engine::OrderId>(tokens[1], "order id")};
    }
    if (keyword == "book") {
        if (nArgs > 1) throw CommandError("expected: book [levels]");
        if (nArgs == 0) return Book{kDefaultBookLevels};
        const auto levels = parseNumber<std::size_t>(tokens[1], "levels");
        if (levels == 0) throw CommandError("levels must be at least 1");
        return Book{levels};
    }

    // The remaining commands take no arguments.
    Command command;
    if (keyword == "trades") {
        command = Trades{};
    } else if (keyword == "help") {
        command = Help{};
    } else if (keyword == "quit" || keyword == "exit") {
        command = Quit{};
    } else {
        throw CommandError("unknown command '" + std::string(tokens[0]) + "' (type 'help')");
    }
    if (nArgs != 0) throw CommandError("expected: " + keyword);
    return command;
}

}  // namespace commands

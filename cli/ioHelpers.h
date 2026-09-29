#pragma once

#include <regex>
#include <stdexcept>
#include <string>
#include "Types.h"

struct ParsedOrder {
    engine::Side     side;
    std::string      traderName;
    engine::Price    price;
    engine::Quantity quantity;
};

inline ParsedOrder parseInput(const std::string& input) {
    std::regex orderPattern(R"(^(Buy|buy|Sell|sell) ([^\s]+) ([1-9][0-9]*) ([1-9][0-9]*)$)");

    std::smatch match;
    if (std::regex_match(input, match, orderPattern)) {
        engine::Side side = (match[1] == "Buy" || match[1] == "buy")
            ? engine::Side::Buy
            : engine::Side::Sell;
        return ParsedOrder{side, match[2], std::stoll(match[3]), std::stoll(match[4])};
    }

    throw std::runtime_error("Invalid User Input");
}

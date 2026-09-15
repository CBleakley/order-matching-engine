#pragma once

#include <regex>
#include "Order.h"
#include "OrderBook.h"

Order parseInput(const std::string& input) {
    std::regex orderPattern(R"(^(Buy|buy|Sell|sell) ([^\s]+) ([1-9][0-9]*) ([1-9][0-9]*)$)");

    std::smatch match;
    if (std::regex_match(input, match, orderPattern)) {
        OrderType type = (match[1] == "Buy" || match[1] == "buy")
            ? OrderType::Buy
            : OrderType::Sell;
        std::string ordererId = match[2];
        int price = std::stoi(match[3]);
        int quantity = std::stoi(match[4]);
        return Order(type, price, quantity, ordererId);
    }

    throw std::runtime_error("Invalid User Input");
};
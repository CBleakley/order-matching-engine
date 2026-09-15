#include <iostream>
#include <regex>
#include <stdexcept>
#include "../include/OrderBook.h"

std::string WELCOME_MSG = 
    "Welcome to Conor's Stock Exchange!\n"
    "Submitting a sell order: Sell <orderer's name> <price> <quantity>\n"
    "Submitting a buy order: Buy <orderer's name> <price> <quantity>\n"
    "Exiting program: Exit\n\n";

Order parseInput(const std::string& input);

int main() {
    std::cout << WELCOME_MSG;

    OrderBook orderBook(std::cout);

    while (true) {
        std::cout << "Enter an order:";

        std::string input;
        std::getline(std::cin, input);

        if (input == "exit" || input == "Exit") {
            break;
        }

        try {
            Order order = parseInput(input);
            orderBook.processOrder(order);
        } catch (const std::runtime_error& e) {
            std::cout << e.what() << '\n';
        }
    }

    return 0;
};

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


#include <iostream>
#include <stdexcept>
#include "../include/ioHelpers.h"
#include "../include/OrderBook.h"
#include "../include/EnvVarHelpers.h"
#include "../include/TcpServer.h"

bool isLocal = getBooleanEnv("IS_LOCAL");

std::string WELCOME_MSG = 
    "Welcome to Conor's Stock Exchange!\n"
    "Submitting a sell order: Sell <orderer's name> <price> <quantity>\n"
    "Submitting a buy order: Buy <orderer's name> <price> <quantity>\n"
    "Exiting program: Exit\n\n";

int main() {
    std::cout << WELCOME_MSG;

    OrderBook orderBook(std::cout);

    if (!isLocal) {
        TcpServer server(orderBook);

        server.run();
    } else {
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

    }

    return 0;
};

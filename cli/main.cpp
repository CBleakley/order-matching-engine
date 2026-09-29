#include <iostream>
#include <exception>
#include <string>
#include "CliSession.h"
#include "EnvVarHelpers.h"
#include "TcpServer.h"

bool isLocal = getBooleanEnv("IS_LOCAL");

std::string WELCOME_MSG = 
    "Welcome to Conor's Stock Exchange!\n"
    "Submitting a sell order: Sell <orderer's name> <price> <quantity>\n"
    "Submitting a buy order: Buy <orderer's name> <price> <quantity>\n"
    "Exiting program: Exit\n\n";

int main() {
    std::cout << WELCOME_MSG;

    CliSession session(std::cout);

    if (!isLocal) {
        TcpServer server(session);

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
                session.handleInput(input);
            } catch (const std::exception& e) {
                std::cout << e.what() << '\n';
            }
        }

    }

    return 0;
}

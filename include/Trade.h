#pragma once

#include <string>
#include <chrono>

class Trade {
    private:
        int price;
        int quantity;
        std::string aggressiveOrderer;
        std::string matchedOrderer;
        long long executionTS;

    public:
        Trade(int price, int quantity, std::string aggressiveOrderer, std::string matchedOrderer)
            : price(price),
              quantity(quantity),
              aggressiveOrderer(aggressiveOrderer),
              matchedOrderer(matchedOrderer),
              executionTS(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()
              ).count()) {}

        int getPrice() const {
            return price;
        }

        int getQuantity() const {
            return quantity;
        }

        std::string getAggressiveOrderer() const {
            return aggressiveOrderer;
        }

        std::string getMatchedOrderer() const {
            return matchedOrderer;
        }

        long long getExecutionTS() const {
            return executionTS;
        }
};

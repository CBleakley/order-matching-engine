#pragma once

#include <string>
#include <chrono>

class Trade {
    private:
        int price;
        int quantity;
        std::string buyTrader;
        std::string sellTrader;
        long long executionTS;

    public:
        Trade(int price, int quantity, std::string buyTrader, std::string sellTrader)
            : price(price),
              quantity(quantity),
              buyTrader(buyTrader),
              sellTrader(sellTrader),
              executionTS(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()
              ).count()) {}

        int getPrice() const {
            return price;
        }

        int getQuantity() const {
            return quantity;
        }

        std::string getBuyOrderer() const {
            return buyTrader;
        }

        std::string getSellOrderer() const {
            return sellTrader;
        }

        long long getExecutionTS() const {
            return executionTS;
        }

        std::string toString() const {
            return "\nTrade executed: price="
                + std::to_string(getPrice())
                + ", quantity="
                + std::to_string(getQuantity())
                + ", buyer="
                + getBuyOrderer()
                + ", seller="
                + getSellOrderer() + '\n';
        }
};

#pragma once

#include <chrono>
#include <string>

enum class OrderType {
    Buy,
    Sell
};

class Order {
    private:
        OrderType type;
        int price;
        int quantity; // TODO: track initial quantity and outstanding seperately
        std::string ordererId; // TODO: Replace with a trader
        long long arrivalTS;

    public:
        Order(OrderType type, int price, int quantity, std::string ordererId)
            : type(type),
              price(price),
              quantity(quantity),
              ordererId(ordererId),
              arrivalTS(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()
              ).count()) {}

        OrderType getType() const {
            return type;
        }

        int getQuantity() const {
            return quantity;
        }

        int getPrice() const {
            return price;
        }

        std::string getOrdererId() const {
            return ordererId;
        }

        void reduceQuantity(int reduction) {
            quantity -= reduction;
        }
};

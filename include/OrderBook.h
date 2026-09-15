#pragma once

#include <map>
#include <ostream>
#include <queue>
#include <cstddef>
#include <string>
#include <vector>
#include <algorithm>
#include "Order.h"
#include "Trade.h"

std::size_t N_TRADES_TO_PRINT = 5;

class OrderBook {
    private:
        std::map<int, std::queue<Order>> buyOrders;
        std::map<int, std::queue<Order>> sellOrders;
        std::vector<Trade> tradeHistory;
        std::ostream& output;

        void addToBook(const Order& order) {
            if (order.getType() == OrderType::Buy) {
                buyOrders[order.getPrice()].push(order);
            }
            else {
                sellOrders[order.getPrice()].push(order);
            }
        }

        void addToTradeHistory(const Trade& trade) {
            tradeHistory.push_back(trade);
        }

        void outputBook(const std::string& title, const std::map<int, std::queue<Order>>& orders, bool descending) const {
            output << title << ":\n";

            if (orders.empty()) {
                output << "  (empty)\n";
                return;
            }

            if (descending) {
                for (auto priceLevel = orders.rbegin(); priceLevel != orders.rend(); ++priceLevel) {
                    outputPriceLevel(priceLevel->first, priceLevel->second);
                }
            } else {
                for (const auto& priceLevel : orders) {
                    outputPriceLevel(priceLevel.first, priceLevel.second);
                }
            }
        }

        void outputPriceLevel(int price, std::queue<Order> orders) const {
            output << "  Price " << price << ":\n";

            while (!orders.empty()) {
                const Order& order = orders.front();
                output << "    "
                       << order.getOrdererId()
                       << " quantity=" << order.getQuantity()
                       << '\n';
                orders.pop();
            }
        }

        void outputLastNTrades(std::size_t& n) const {
            output << "Last" << n << "trades:\n";

            if (tradeHistory.empty()) {
                output << "  (none)\n";
                return;
            }

            std::size_t start = tradeHistory.size() > n ? tradeHistory.size() - n : 0;
            for (std::size_t i = start; i < tradeHistory.size(); ++i) {
                const Trade& trade = tradeHistory[i];
                output << trade.toString();
            }
        }

        void outputState() const {
            output << "\nOrder book state\n";
            outputBook("Buy book", buyOrders, true);
            outputBook("Sell book", sellOrders, false);
            outputLastNTrades(N_TRADES_TO_PRINT);
            output << '\n';
        }

    public:
        OrderBook(std::ostream& output) : output(output) {}

        void processOrder(Order aggressiveOrder) {
            while (aggressiveOrder.getQuantity() > 0) {
                std::map<int, std::queue<Order>>& matchingBook =
                    aggressiveOrder.getType() == OrderType::Buy
                        ? sellOrders
                        : buyOrders;

                if (matchingBook.empty()) {
                    addToBook(aggressiveOrder);
                    break;
                }

                std::queue<Order>& queue = 
                    aggressiveOrder.getType() == OrderType::Buy
                        ? matchingBook.begin() ->second
                        : matchingBook.rbegin()->second;

                Order& matchedOrder = queue.front();
                if (aggressiveOrder.getType() == OrderType::Buy && matchedOrder.getPrice() > aggressiveOrder.getPrice()) {
                    addToBook(aggressiveOrder);
                    break;
                }

                if (aggressiveOrder.getType() == OrderType::Sell && matchedOrder.getPrice() < aggressiveOrder.getPrice()) {
                    addToBook(aggressiveOrder);
                    break;
                }

                int matchedOrderPrice = matchedOrder.getPrice();
                int tradeQuantity = std::min(
                    aggressiveOrder.getQuantity(),
                    matchedOrder.getQuantity()
                );
                Trade trade(
                    matchedOrderPrice,
                    tradeQuantity,
                    aggressiveOrder.getOrdererId(),
                    matchedOrder.getOrdererId()
                );

                aggressiveOrder.reduceQuantity(tradeQuantity);
                matchedOrder.reduceQuantity(tradeQuantity);

                if (matchedOrder.getQuantity() == 0) {
                    queue.pop();

                    if (queue.empty()) {
                        matchingBook.erase(matchedOrderPrice);
                    }
                }

                addToTradeHistory(trade);
                output << trade.toString();
                outputState();
            }
        }
};

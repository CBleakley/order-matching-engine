#include <map>
#include <queue>
#include <vector>
#include <algorithm>
#include "Order.h"
#include "Trade.h"

class OrderBook {
    private:
        std::map<int, std::queue<Order>> buyOrders;
        std::map<int, std::queue<Order>> sellOrders;
        std::vector<Trade> tradeHistory;

        void executeTrade(Order matchedOrder, Order aggressiveOrder) {
            int tradePrice = matchedOrder.getPrice();
            int tradeQuantity = std::min(
                aggressiveOrder.getQuantity(),
                matchedOrder.getQuantity()
            );
            Trade trade(
                tradePrice, 
                tradeQuantity, 
                aggressiveOrder.getOrdererId(), 
                matchedOrder.getOrdererId()
            );

            aggressiveOrder.reduceQuantity(tradeQuantity);
            matchedOrder.reduceQuantity(tradeQuantity);

            addToTradeHistory(trade);
        };

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

    public:
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

                executeTrade(matchedOrder, aggressiveOrder);

                if (matchedOrder.getQuantity() == 0) {
                    queue.pop();

                    if (queue.empty()) {
                        matchingBook.erase(matchedOrder.getPrice());
                    }
                }
            }
        }
};
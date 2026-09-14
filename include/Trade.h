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
        Trade(int price, int quantity, std::string buyOrderer, std::string sellOrderer) {
            price = price;
            quantity = quantity;
            
            buyOrderer = buyOrderer;
            sellOrderer = sellOrderer;
            
            long long executionTS = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()
            ).count();
        }
};
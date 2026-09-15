#include <iostream>
#include <winsock2.h>
#include <ws2tcpip.h>
#include "Order.h"
#include "OrderBook.h"

#pragma comment(lib, "Ws2_32.lib")

class TcpServer {
private:
    OrderBook& orderBook;

public:
    TcpServer(OrderBook& orderBook)
        : orderBook(orderBook) {}

    void run() {
        // Initialise Winsock
        WSADATA wsaData;
        WSAStartup(MAKEWORD(2, 2), &wsaData);

        // Create socket
        SOCKET serverSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

        // Configure address
        sockaddr_in serverAddress{};
        serverAddress.sin_family = AF_INET;
        serverAddress.sin_addr.s_addr = INADDR_ANY;
        serverAddress.sin_port = htons(8080);

        // Bind socket to port
        bind(
            serverSocket,
            reinterpret_cast<sockaddr*>(&serverAddress),
            sizeof(serverAddress)
        );

        // Start listening
        listen(serverSocket, SOMAXCONN);

        std::cout << "Server listening on port 8080...\n";

        while (true) {
            // Accept a client
            SOCKET clientSocket = accept(serverSocket, nullptr, nullptr);

            std::cout << "Client connected!\n";

            char buffer[1024];

            // Continuously orders from this client
            while (true) {
                int bytesReceived = recv(
                    clientSocket,
                    buffer,
                    sizeof(buffer) - 1,
                    0
                );

                if (bytesReceived <= 0) {
                    break;
                }

                std::string input(buffer, bytesReceived);

                std::cout << "Received: " << input << '\n';

                try {
                    Order order = parseInput(input);
                    orderBook.processOrder(order);
                }
                catch (const std::runtime_error& e) {
                    std::cout << e.what() << '\n';
                }

                // Send response
                const char* response = "Order received";

                send(
                    clientSocket,
                    response,
                    strlen(response),
                    0
                );
            }

            std::cout << "Client disconnected.\n";

            closesocket(clientSocket);
        }

        closesocket(serverSocket);
        WSACleanup();
    }
};
#include <cstddef>
#include <iostream>
#include <string_view>

#include "CommandParser.h"
#include "Repl.h"

namespace {

void printUsage(std::ostream& os) {
    os << "Usage: cli [--trades N]\n"
          "  --trades N   number of recent trades kept for the 'trades' command (default 5)\n";
}

}  // namespace

int main(int argc, char** argv) {
    ReplOptions options;

    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--help" || arg == "-h") {
            printUsage(std::cout);
            return 0;
        }
        if (arg == "--trades" && i + 1 < argc) {
            try {
                options.tradeHistory = commands::parseNumber<std::size_t>(argv[++i], "trade count");
            } catch (const commands::CommandError& e) {
                std::cerr << "error: " << e.what() << '\n';
                return 2;
            }
            if (options.tradeHistory == 0) {
                std::cerr << "error: trade count must be at least 1\n";
                return 2;
            }
            continue;
        }
        printUsage(std::cerr);
        return 2;
    }

    runRepl(std::cin, std::cout, options);
    return 0;
}

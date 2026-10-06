#pragma once

#include <cstddef>
#include <istream>
#include <ostream>
#include <string>

#include "CliSession.h"

struct ReplOptions {
    std::size_t tradeHistory = 5;
    // Write each input line after the prompt, so the output reads as a full
    // transcript when input is not typed at a terminal (e.g. golden tests).
    bool echo = false;
};

// Reads commands from `in` until `quit` or end of input.
inline void runRepl(std::istream& in, std::ostream& out, const ReplOptions& options = {}) {
    CliSession session(out, options.tradeHistory);
    out << "Order matching engine. Type 'help' for commands.\n";

    std::string line;
    while (true) {
        out << "> ";
        if (!std::getline(in, line)) {
            out << '\n';
            break;
        }
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (options.echo) out << line << '\n';
        if (!session.execute(line)) break;
    }
}

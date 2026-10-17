#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

// Access to the language-neutral fixtures in protocol/, which the TypeScript
// tests also consume.

namespace protocol_fixtures {

inline const std::filesystem::path kProtocolDir = PROTOCOL_DIR;

inline nlohmann::json readJson(const std::filesystem::path& relativePath) {
    const std::filesystem::path path = kProtocolDir / relativePath;
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("Cannot open fixture " + path.string());
    return nlohmann::json::parse(in);
}

// Reads a .hex fixture: whitespace-separated hex byte pairs, with '#'
// starting a comment that runs to the end of the line.
inline std::vector<std::uint8_t> readHex(const std::filesystem::path& relativePath) {
    const std::filesystem::path path = kProtocolDir / relativePath;
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("Cannot open fixture " + path.string());

    std::vector<std::uint8_t> bytes;
    std::string line;
    while (std::getline(in, line)) {
        line = line.substr(0, line.find('#'));
        std::istringstream tokens(line);
        std::string token;
        while (tokens >> token) {
            if (token.size() != 2 || token.find_first_not_of("0123456789abcdefABCDEF") !=
                                         std::string::npos) {
                throw std::runtime_error("Bad hex byte '" + token + "' in " + path.string());
            }
            bytes.push_back(static_cast<std::uint8_t>(std::stoul(token, nullptr, 16)));
        }
    }
    return bytes;
}

}  // namespace protocol_fixtures

#pragma once

#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

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

}  // namespace protocol_fixtures

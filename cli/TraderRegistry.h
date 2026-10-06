#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include "Types.h"

// Maps the trader names users type to the compact TraderIds the engine uses,
// and back again for display. IDs are assigned in order of first use.
class TraderRegistry {
public:
    engine::TraderId idFor(const std::string& name) {
        auto [it, inserted] = ids_.try_emplace(name, static_cast<engine::TraderId>(names_.size()));
        if (inserted) names_.push_back(name);
        return it->second;
    }

    const std::string& nameOf(engine::TraderId id) const { return names_.at(id); }

private:
    std::unordered_map<std::string, engine::TraderId> ids_;
    std::vector<std::string> names_;
};

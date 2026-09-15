#include <cstdlib>
#include <string>

bool getBooleanEnv(const char* name) {
    const char* value = std::getenv(name);

    if (value == nullptr) {
        return false;
    }

    return std::string(value) == "true";
}
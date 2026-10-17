// Engine service entry point. For now it only loads and validates the
// instrument config; the event loop and gateway connection arrive in P1-04.
#include <filesystem>
#include <iostream>
#include <string_view>

#include "Instrument.h"
#include "Price.h"

namespace {

constexpr std::string_view kUsage = "usage: engine_service [--instrument <path>]\n";

}  // namespace

int main(int argc, char* argv[]) {
    std::filesystem::path instrumentPath = "protocol/instrument.json";
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--instrument" && i + 1 < argc) {
            instrumentPath = argv[++i];
        } else {
            std::cerr << kUsage;
            return 2;
        }
    }

    try {
        const engine_service::InstrumentConfig instrument =
            engine_service::loadInstrumentConfig(instrumentPath);
        std::cout << "Instrument " << instrument.symbol << " (" << instrument.name
                  << "): tick " << instrument.tickSize << ", prices "
                  << engine_service::ticksToDecimalString(instrument.minPriceTicks, instrument)
                  << " to "
                  << engine_service::ticksToDecimalString(instrument.maxPriceTicks, instrument)
                  << ", max order qty " << instrument.maxOrderQty << ", reference "
                  << engine_service::ticksToDecimalString(instrument.referencePriceTicks,
                                                          instrument)
                  << '\n';
    } catch (const engine_service::InstrumentConfigError& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
    return 0;
}

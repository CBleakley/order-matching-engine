#pragma once

#include <ostream>

#include "TypeStrings.h"
#include "Types.h"

// Stream operators for engine enums, used by GoogleTest to print values in
// failure messages and parameterized test names. They live in namespace engine
// so they are found by ADL.
//
// Every test file that prints these enums through GoogleTest (e.g. EXPECT_EQ
// on a Side) must include this header. Otherwise that file instantiates
// GoogleTest's printer without these operators, and the linker may keep that
// raw-bytes version for the whole test binary.

namespace engine {

inline std::ostream& operator<<(std::ostream& os, Side side) { return os << toString(side); }

inline std::ostream& operator<<(std::ostream& os, RejectReason reason) {
    return os << toString(reason);
}

}  // namespace engine

// Verifies that Invariants.h compiles on its own: it is the only include in
// this translation unit, so any missing transitive dependency fails the build.
#include "Invariants.h"

#include <optional>
#include <type_traits>

static_assert(std::is_same_v<decltype(engine::checkInvariants(std::declval<const engine::OrderBook&>())),
                             std::optional<engine::InvariantViolation>>);
static_assert(engine::describe(engine::Invariant::CrossedBook)[0] != '\0');

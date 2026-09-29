// Verifies that Types.h compiles on its own: it is the only include in this
// translation unit, so any missing transitive dependency fails the build.
#include "Types.h"

#include <type_traits>

static_assert(std::is_trivially_copyable_v<engine::Order>);
static_assert(std::is_aggregate_v<engine::Order>);
static_assert(sizeof(engine::Side) == 1);
static_assert(sizeof(engine::RejectReason) == 1);
static_assert(engine::opposite(engine::Side::Buy) == engine::Side::Sell);

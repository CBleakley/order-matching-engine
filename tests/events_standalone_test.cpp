// Verifies that Events.h compiles on its own: it is the only include in this
// translation unit, so any missing transitive dependency fails the build.
#include "Events.h"

#include <type_traits>

static_assert(std::is_trivially_copyable_v<engine::OrderAccepted>);
static_assert(std::is_trivially_copyable_v<engine::OrderRejected>);
static_assert(std::is_trivially_copyable_v<engine::TradeEvent>);
static_assert(std::is_trivially_copyable_v<engine::OrderRested>);
static_assert(std::is_trivially_copyable_v<engine::OrderCancelled>);
static_assert(std::is_aggregate_v<engine::TradeEvent>);
static_assert(std::has_virtual_destructor_v<engine::EventSink>);
// The base sink is usable as-is (every handler is a no-op).
static_assert(!std::is_abstract_v<engine::EventSink>);

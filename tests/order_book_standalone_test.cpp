// Verifies that OrderBook.h compiles on its own: it is the only include in
// this translation unit, so any missing transitive dependency fails the build.
#include "OrderBook.h"

#include <type_traits>

static_assert(std::is_constructible_v<engine::OrderBook, engine::EventSink&>);
static_assert(!std::is_default_constructible_v<engine::OrderBook>);
static_assert(!std::is_copy_constructible_v<engine::OrderBook>);

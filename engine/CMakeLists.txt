# Header-only library containing the order book and domain types.
# The core must not depend on <iostream>, <ostream> or <string>.
add_library(engine INTERFACE)
target_include_directories(engine INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(engine INTERFACE cxx_std_20)

# Debug option: verify the book after every operation and abort on corruption.
# When off, the checks are compiled out entirely.
if(ENGINE_CHECK_INVARIANTS)
    target_compile_definitions(engine INTERFACE ENGINE_CHECK_INVARIANTS)
endif()

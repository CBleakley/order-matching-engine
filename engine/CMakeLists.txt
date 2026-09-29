# Header-only library containing the order book and domain types.
# The core must not depend on <iostream>, <ostream> or <string>.
add_library(engine INTERFACE)
target_include_directories(engine INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(engine INTERFACE cxx_std_20)

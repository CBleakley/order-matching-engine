include(FetchContent)

# JSON parsing for the instrument config. Only the engine service uses it; the
# engine library stays dependency-free. SYSTEM keeps its headers out of our
# warnings-as-errors checks.
FetchContent_Declare(
    nlohmann_json
    URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    SYSTEM
)
FetchContent_MakeAvailable(nlohmann_json)

# Header-only engine service library: instrument config and price conversion.
# Shared by the engine_service executable and the tests.
add_library(engine_service_lib INTERFACE)
target_include_directories(engine_service_lib INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(engine_service_lib INTERFACE engine nlohmann_json::nlohmann_json)

# The engine service process; the event loop and gateway connection arrive in P1-04.
add_executable(engine_service main.cpp)
target_link_libraries(engine_service PRIVATE engine_service_lib)
set_project_warnings(engine_service)

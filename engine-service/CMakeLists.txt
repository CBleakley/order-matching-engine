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

# Standalone (non-Boost) Asio for networking and timers, used only by the
# engine service. It has no CMake project of its own, so MakeAvailable only
# downloads it.
FetchContent_Declare(
    asio
    URL https://github.com/chriskohlhoff/asio/archive/refs/tags/asio-1-38-2.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(asio)
find_package(Threads REQUIRED)

add_library(asio_standalone INTERFACE)
target_include_directories(asio_standalone SYSTEM INTERFACE ${asio_SOURCE_DIR}/include)
target_compile_definitions(asio_standalone INTERFACE ASIO_STANDALONE ASIO_NO_DEPRECATED)
target_link_libraries(asio_standalone INTERFACE Threads::Threads)
if(WIN32)
    target_compile_definitions(asio_standalone INTERFACE _WIN32_WINNT=0x0A00)
    target_link_libraries(asio_standalone INTERFACE ws2_32 mswsock)
endif()

# Header-only engine service library with no networking: instrument config,
# price conversion, the internal protocol codec, and the socket-free engine
# core and gateway session.
add_library(engine_service_lib INTERFACE)
target_include_directories(engine_service_lib INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(engine_service_lib INTERFACE engine nlohmann_json::nlohmann_json)

# The TCP server on top of the library. Shared by the executable and the tests.
add_library(engine_service_net INTERFACE)
target_link_libraries(engine_service_net INTERFACE engine_service_lib asio_standalone)

add_executable(engine_service main.cpp)
target_link_libraries(engine_service PRIVATE engine_service_net)
set_project_warnings(engine_service)

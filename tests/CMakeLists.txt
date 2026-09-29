include(FetchContent)

FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
# Use the same (shared) CRT as the rest of the project on MSVC.
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

add_executable(tests
    placeholder_test.cpp
    types_standalone_test.cpp
    types_test.cpp
    events_standalone_test.cpp
    recording_sink_test.cpp
)
target_link_libraries(tests PRIVATE engine GTest::gtest_main)
set_project_warnings(tests)

include(GoogleTest)
gtest_discover_tests(tests)

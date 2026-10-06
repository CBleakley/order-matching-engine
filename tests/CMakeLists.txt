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
    types_standalone_test.cpp
    types_test.cpp
    events_standalone_test.cpp
    recording_sink_test.cpp
    order_book_standalone_test.cpp
    order_book_test.cpp
    order_book_cancel_test.cpp
    order_book_query_test.cpp
    invariants_standalone_test.cpp
    invariants_test.cpp
    console_sink_test.cpp
    golden_test.cpp
)
target_link_libraries(tests PRIVATE engine cli_lib GTest::gtest_main)
set_project_warnings(tests)
target_compile_definitions(tests PRIVATE GOLDEN_DIR="${CMAKE_CURRENT_SOURCE_DIR}/golden")
if(MSVC)
    # std::getenv is standard C++; silence MSVC's deprecation in favour of _dupenv_s.
    target_compile_definitions(tests PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()

include(GoogleTest)
gtest_discover_tests(tests)

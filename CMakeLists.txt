cmake_minimum_required(VERSION 3.25)

project(order_matching_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(ENABLE_SANITIZERS "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

# Sanitizers are applied globally (including to GoogleTest) so that all
# linked code is instrumented consistently.
if(ENABLE_SANITIZERS)
    if(MSVC)
        # MSVC supports AddressSanitizer only; it has no UBSan equivalent.
        # /RTC* runtime checks are incompatible with /fsanitize=address.
        string(REGEX REPLACE "/RTC[^ ]*" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
        add_compile_options(/fsanitize=address)
    else()
        add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)
        add_link_options(-fsanitize=address,undefined)
    endif()
endif()

# Warning flags for this project's own targets (not third-party code).
function(set_project_warnings target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /WX /permissive-)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
endfunction()

add_subdirectory(engine)
add_subdirectory(cli)
add_subdirectory(bench)

enable_testing()
add_subdirectory(tests)

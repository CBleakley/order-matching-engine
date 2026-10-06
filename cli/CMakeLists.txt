# Header-only CLI library: command parsing, console output and the REPL.
# Shared by the cli executable and the golden tests.
add_library(cli_lib INTERFACE)
target_include_directories(cli_lib INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(cli_lib INTERFACE engine)

add_executable(cli main.cpp)
target_link_libraries(cli PRIVATE cli_lib)
set_project_warnings(cli)

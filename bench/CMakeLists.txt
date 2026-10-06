# Placeholder for Phase 1 benchmarks.
add_executable(bench main.cpp)
target_link_libraries(bench PRIVATE engine order_flow)
set_project_warnings(bench)

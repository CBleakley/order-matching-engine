# Placeholder for the Phase 1 engine service (P1-04).
add_executable(engine_service main.cpp)
target_link_libraries(engine_service PRIVATE engine)
set_project_warnings(engine_service)

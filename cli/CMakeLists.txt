add_executable(cli main.cpp)
target_link_libraries(cli PRIVATE engine)
set_project_warnings(cli)

if(WIN32)
    target_link_libraries(cli PRIVATE ws2_32)
endif()

if(MSVC)
    # std::getenv is standard C++; silence MSVC's deprecation in favour of _dupenv_s.
    target_compile_definitions(cli PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()

# Order Matching Engine

A price-time priority order matching engine. See [Requirements.md](Requirements.md) for the design.

## Project layout

| Directory         | Target   | Description                                                     |
|-------------------|----------|-----------------------------------------------------------------|
| `engine/include/` | `engine` | Header-only library: order book and domain types (no iostream). |
| `cli/`            | `cli`    | Command-line program / TCP server, links `engine`.              |
| `tests/`          | `tests`  | GoogleTest suite (fetched via `FetchContent`), run with CTest.  |
| `bench/`          | `bench`  | Placeholder for Phase 1 benchmarks.                             |

## Building

Requires CMake 3.25+, Ninja, and a C++20 compiler. On Windows, run the commands from a
**Developer PowerShell / Developer Command Prompt for Visual Studio** so that MSVC (and, for
the sanitizer build, the ASan runtime DLL) is on the path.

```sh
cmake --preset debug
cmake --build --preset debug
```

Available presets (build output goes to `build/<preset>/`):

- `debug`: Debug build.
- `release`: Release build.
- `debug-sanitize`: Debug build with AddressSanitizer and UndefinedBehaviorSanitizer.
  MSVC only supports AddressSanitizer, so UBSan is enabled only with GCC/Clang.

All project targets compile with warnings as errors (`-Wall -Wextra -Wpedantic -Werror`,
or `/W4 /WX /permissive-` on MSVC).

## Running the CLI

By default the CLI starts a TCP server on port 8080 (Windows only). Set `IS_LOCAL=true` to
enter orders interactively instead:

```powershell
$env:IS_LOCAL = "true"
./build/debug/cli/cli.exe
```

Orders have the form `Buy <name> <price> <quantity>` or `Sell <name> <price> <quantity>`;
type `Exit` to quit.

## Running the tests

```sh
ctest --preset debug
```

Use `--preset debug-sanitize` to run the tests under the sanitizers.

# Order Matching Engine

A price-time priority order matching engine. See [Requirements.md](Requirements.md) for the design.

## Project layout

| Directory         | Target   | Description                                                     |
|-------------------|----------|-----------------------------------------------------------------|
| `engine/include/` | `engine` | Header-only library: order book and domain types (no iostream). |
| `cli/`            | `cli`    | Interactive command-line front end, links `engine`.             |
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

```sh
./build/debug/cli/cli          # cli.exe on Windows
./build/debug/cli/cli --trades 10   # keep the last 10 trades for `trades` (default 5)
```

Commands (keywords are case-insensitive):

| Command                       | Description                                             |
|-------------------------------|---------------------------------------------------------|
| `buy <trader> <qty> <price>`  | Submit a buy order. The assigned order ID is printed.   |
| `sell <trader> <qty> <price>` | Submit a sell order.                                    |
| `cancel <orderId>`            | Cancel a resting order.                                 |
| `book [levels]`               | Show both sides of the book (default 10 levels a side). |
| `trades`                      | Show the most recent trades.                            |
| `help`                        | List the commands.                                      |
| `quit`                        | Exit (end of input also exits).                         |

Malformed commands print an error and the CLI carries on. Commands can also be piped in:
`cli < script.txt`.

## Running the tests

```sh
ctest --preset debug
```

Use `--preset debug-sanitize` to run the tests under the sanitizers.

The CLI golden tests run each `tests/golden/<name>.in` script through the CLI and compare the
transcript with `<name>.expected`, printing a line diff on mismatch. After an intended output
change, regenerate the expected files with `GOLDEN_UPDATE=1` set while running the tests, and
review the diff before committing.

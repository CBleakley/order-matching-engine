# Order Matching Engine

[![CI](https://github.com/CBleakley/order-matching-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/CBleakley/order-matching-engine/actions/workflows/ci.yml)

A price-time priority order matching engine. See [Requirements.md](Requirements.md) for the design.

## Project layout

| Directory         | Target           | Description                                                     |
|-------------------|------------------|-----------------------------------------------------------------|
| `engine/include/` | `engine`         | Header-only library: order book and domain types (no iostream). |
| `cli/`            | `cli`            | Interactive command-line front end, links `engine`.             |
| `tests/`          | `tests`          | GoogleTest suite (fetched via `FetchContent`), run with CTest.  |
| `bench/`          | `bench`          | Placeholder for Phase 1 benchmarks.                             |
| `engine-service/` | `engine_service` | Phase 1 engine service; loads the instrument config for now.    |

## Phase 1 layout

Phase 1 adds a web UI on top of the engine. The new directories are:

| Directory         | Contents                                                                                      |
|-------------------|-----------------------------------------------------------------------------------------------|
| `engine-service/` | C++ engine service: owns the order book, talks to the gateway over private TCP.               |
| `protocol/`       | Language-neutral protocol material: internal protocol spec, byte fixtures, instrument config. |
| `shared/`         | npm package `@ome/shared`: public WebSocket protocol schemas and price helpers.               |
| `gateway/`        | npm package `@ome/gateway`: the internet-facing Node gateway.                                 |
| `web/`            | npm package `@ome/web`: the React front end.                                                  |

The TypeScript packages are npm workspaces sharing one root toolchain: TypeScript in `strict`
mode (ESM, `tsconfig.base.json`), ESLint with typescript-eslint, Prettier and Vitest.
`protocol/` is also a workspace (`@ome/protocol`, data files only) so that TypeScript can
import its JSON files.

The instrument (NOVA, tick size 0.01) is defined once in `protocol/instrument.json`; see
[protocol/README.md](protocol/README.md) for its fields, validation rules and the price
fixtures shared by the C++ and TypeScript tests. `engine_service` reads it at startup from
`protocol/instrument.json` relative to the working directory, or from
`engine_service --instrument <path>`, and exits with an error if it is invalid.

The gateway and engine service talk over a private binary protocol specified in
[protocol/internal-protocol.md](protocol/internal-protocol.md). Its C++ codec is in
`engine-service/` (`InternalProtocol.h`, `FrameDecoder.h`) and its TypeScript codec in
`gateway/src/internal/`; both are tested against the byte fixtures in
`protocol/fixtures/internal/`.

Prerequisites: Node 24 LTS (pinned in `.nvmrc` and `engines`) and npm 11.

```sh
npm ci            # install from package-lock.json
npm run check     # lint + typecheck + test, as run in CI
```

Individual scripts: `npm run build` (every package to its `dist/`), `npm run lint` (ESLint and
`prettier --check`), `npm run typecheck`, `npm test` and `npm run format` (Prettier, in place).
Each script builds `@ome/shared` first, since the other packages import its compiled output.

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
  It also turns on `ENGINE_CHECK_INVARIANTS`, which checks the whole order book after every
  `submit` and `cancel` and aborts with a description of the first broken invariant. In
  other builds the checks are compiled out entirely. Pass `-DENGINE_CHECK_INVARIANTS=ON`
  to enable them in any build.

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

### Differential tests

`tests/ReferenceOrderBook.h` is a deliberately naive order book (one vector, linear scans).
The differential tests feed identical seeded random order flow (`tests/RandomOrderFlow.h`) to
it and to the real engine, and fail on the first difference in their events or visible state,
reporting the seed, operation and differing events. To rerun a single seed, set `DIFF_SEED`:

```sh
DIFF_SEED=42 ./build/debug/tests/tests --gtest_filter=Differential.DefaultFlow
```

Longer runs (several million operations) are labelled `slow` and excluded from the default
test presets. Run them with:

```sh
cmake --preset release && cmake --build --preset release
ctest --preset slow
```

### Golden tests

The CLI golden tests run each `tests/golden/<name>.in` script through the CLI and compare the
transcript with `<name>.expected`, printing a line diff on mismatch. After an intended output
change, regenerate the expected files with `GOLDEN_UPDATE=1` set while running the tests, and
review the diff before committing.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request, and can be
started by hand from the Actions tab. It builds and tests the `release` and `debug-sanitize`
presets on both Ubuntu (GCC, ASan + UBSan) and Windows (MSVC, ASan), using the same
`cmake --preset` / `ctest --preset` commands as a local build. Tests labelled `slow` are not
run in CI. A separate `node` job on Ubuntu runs `npm ci` and `npm run check`.

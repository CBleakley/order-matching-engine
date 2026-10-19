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
| `engine-service/` | `engine_service` | Engine service: order book plus TCP server for the gateway.     |

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

## Running the engine service

`engine_service` hosts the order book and serves one gateway over TCP using the internal
protocol. Run it from the repository root so it finds `protocol/instrument.json`:

```sh
./build/debug/engine-service/engine_service      # engine_service.exe on Windows
./build/debug/engine-service/engine_service --port 7002 --log-level debug
```

| Option                | Default                    | Description                                         |
|-----------------------|----------------------------|-----------------------------------------------------|
| `--bind <address>`    | `127.0.0.1`                | Address to listen on. Keep it private.              |
| `--port <port>`       | `7001`                     | Port to listen on (`0` picks a free port).          |
| `--instrument <path>` | `protocol/instrument.json` | Instrument config to load at startup.               |
| `--log-level <level>` | `info`                     | `error`, `warn`, `info` or `debug`.                 |
| `--retention <time>`  | `24h`                      | How long to keep trades for replay (`s`, `m`, `h`). |
| `--sim-config <path>` | built-in defaults          | Market simulator config (JSON; see below).          |
| `--seed <n>`          | random (logged)            | Simulator random seed, to reproduce a run.          |
| `--warmup <time>`     | `6h`                       | History to backfill at boot (`0s` for none).        |
| `--no-sim`            | off                        | Run without simulated traders.                      |

The engine service owns order identity: it assigns every order ID, checks prices and quantities
against the instrument's limits, and only lets an order's owner cancel it. When a gateway
connects (or reconnects), it first receives a snapshot of every resting order and the trades
from the retention period, so it can rebuild its state.

It logs to stderr: one line per connection, disconnection or protocol error, never per order.
Everything (socket I/O, timers and the order book) runs on a single thread with one Asio
`io_context`, so the book needs no locks. Only one gateway is served at a time; see
[protocol/internal-protocol.md](protocol/internal-protocol.md) for the handshake, heartbeats
and limits. Ctrl+C or SIGTERM shuts it down cleanly.

The code is split so that most of it is testable without sockets: `EngineCore.h` turns
decoded commands into order book calls and protocol events, `GatewaySession.h` is the
per-connection protocol state machine (bytes in, bytes out), and `TcpServer.h` only moves
bytes between the socket and the session.

### Market simulator

Simulated traders keep the market busy. They run inside the engine service on the engine thread
and submit through the same `EngineCore` path as gateway commands, so their orders are
validated and reported like anyone else's. Their events go to the gateway like any others.

- A **fair value** follows a random walk with clustered volatility, a slow trend and a weak pull
  back to the instrument's `referencePriceTicks`, stepping once per simulated second.
- **Market makers** quote a bid and an ask around fair value and refresh them (cancel and
  replace) every 1–3 seconds, or sooner when fair value moves. They keep the book two-sided.
- **Takers** arrive as a Poisson process (about 2 a second), lean toward fair value versus the
  last trade, and send limit orders a few ticks through the touch. Any unfilled remainder is
  cancelled. These produce the trades that make candles.
- **Liquidity providers** rest orders a few ticks behind the touch for a while, adding depth.

Simulated traders have trader IDs 1 to 999 (human traders are 1,000,000 or above). They follow
their own orders only from the events addressed to them, plus public market data: best bid and
ask, and the last trade price. Every parameter is in
[engine-service/sim-config.json](engine-service/sim-config.json), which lists the built-in
defaults; pass a file with any subset of its keys to `--sim-config`.

At startup, before it listens for a gateway, the engine service **warms up**: it runs the
simulator from `now - warmup` to now as fast as possible, with events stamped with simulated
time. A 6-hour warm-up takes well under a second in a Release build. The retained trades then
backfill the chart through the reconnect snapshot. After that the simulator runs on the wall
clock from Asio timers, and its resting orders carry over.

Randomness comes from `std::mt19937_64` with hand-written samplers (no standard
distributions), so the same seed, config and clock give the same event stream. `--no-sim`
turns the simulator off for tests that need full control of the book.

## Running the gateway

The gateway (`gateway/`) is the internet-facing Node process. It keeps a connection to the
engine service open and serves HTTP. Build it, then start it with at least `SESSION_SECRET` set:

```powershell
npm run build
$env:SESSION_SECRET = '<at least 32 random characters>'
npm start -w @ome/gateway
```

| Variable                        | Default     | Description                                                     |
|---------------------------------|-------------|-----------------------------------------------------------------|
| `SESSION_SECRET`                | (required)  | Signs session tokens. At least 32 characters.                   |
| `PORT`                          | `8080`      | HTTP port.                                                      |
| `HOST`                          | `0.0.0.0`   | HTTP bind address.                                              |
| `ENGINE_HOST`                   | `127.0.0.1` | Engine service address.                                         |
| `ENGINE_PORT`                   | `7001`      | Engine service port.                                            |
| `LOG_LEVEL`                     | `info`      | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `TRUST_PROXY`                   | (none)      | Reverse proxy IPs/CIDRs (comma-separated) trusted for the IP.   |
| `SESSION_MAX_AGE_SECONDS`       | `604800`    | Session tokens older than this (7 days) are rejected.           |
| `SESSION_RATE_LIMIT_PER_MINUTE` | `10`        | `POST /api/session` requests per client IP per minute.          |
| `MAX_SESSIONS`                  | `1000`      | Limit on concurrent sessions (enforced by later tickets).       |
| `MAX_OPEN_ORDERS_PER_SESSION`   | `50`        | Limit on resting orders per session (later tickets).            |
| `MAX_ORDERS_PER_SECOND`         | `10`        | Per-session order rate limit (later tickets).                   |
| `MAX_WS_MESSAGE_BYTES`          | `4096`      | Largest accepted WebSocket message (later tickets).             |

Invalid configuration stops it at startup with a list of the bad variables (never their values).
It logs JSON lines to stdout (pino), with secret-bearing fields redacted.

`GET /healthz` returns `200 {"status":"ok","engine":{"connected":true,"engineInstanceId":"…"}}`
while the engine connection is up, and `503` with `"status":"unavailable"` otherwise.

`POST /api/session` with `{"name":"…"}` joins as an anonymous trader and returns
`{"token":"…","traderId":1234567,"name":"…"}`. Names are trimmed and must be 2 to 20 letters,
digits, spaces, `-` or `_`; anything else gets `400 {"error":"invalidName","message":"…"}`. The
trader ID is random in `[1000000, 2^31)` and is drawn again if it matches any trader ID the
gateway knows of (ones it issued, ones the engine reports, and ones in tokens it has verified).
Requests are rate-limited per client IP (`429` with `Retry-After`), and the endpoint answers
`503` while the engine is disconnected. Behind a reverse proxy, list its address in
`TRUST_PROXY`; the client IP is then the right-most `X-Forwarded-For` entry that is not a
trusted proxy, so entries a client adds itself are ignored.

The token is `base64url(payload).base64url(HMAC-SHA256(SESSION_SECRET, payload))` and carries
the trader ID, name, `engineInstanceId` and issue time; the gateway keeps no session table
(`gateway/src/session/`). It is rejected, and the client must join again, when the signature
is wrong, it is older than `SESSION_MAX_AGE_SECONDS`, or it was issued by a different engine
instance (the engine restarted and its book is gone). Clients present it in their first
WebSocket message, never in a URL, and the gateway never logs it.

`EngineClient` (`gateway/src/engine/engine-client.ts`) owns the engine connection. It sends
`Hello`, consumes the snapshot, then streams live events, with heartbeats both ways. It drops
the connection on any protocol violation, an `eventSeq` gap, or 5 seconds of silence, then
reconnects with exponential backoff and jitter, starting each time from a fresh snapshot. A
changed `engineInstanceId` raises `engineReset`. `submit` and `cancel` resolve with the
engine's reply (`OrderAccepted`, `OrderCancelled` or `OrderRejected`). They reject if the
engine does not answer within 5 seconds or the connection drops first.

`MarketData` (`gateway/src/market/`) turns trades into candles for the 5s, 15s, 1m and 5m
intervals (the newest 1,000 bars of each, aligned to UTC boundaries) and the daily header stats
(open, high and low reset at 00:00 UTC). It is rebuilt from scratch from every engine snapshot's
replayed trades, then updated by live trades. An interval with no trades has no bar, so the
chart shows a gap. A trade stamped earlier than the one before it is folded into the current bar
and day instead of being dropped, so volume is never lost and bars never move back in time.

The gateway tests run against an in-process fake engine. `gateway/test/integration/` also
runs against the real `engine_service` when it has been built (or `ENGINE_SERVICE_BIN` points
at it), and is skipped otherwise.

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

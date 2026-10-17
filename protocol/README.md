# Protocol

Language-neutral protocol material shared by the C++ engine service and the TypeScript
packages: the instrument configuration (P1-02) and the internal binary protocol spec and
byte fixtures (P1-03).

- [internal-protocol.md](internal-protocol.md): the gateway ↔ engine service binary protocol
  (framing, every message, errors). Its byte fixtures are in `fixtures/internal/`.

This directory is also the private npm workspace `@ome/protocol`, so TypeScript code imports
these files as packages (`import raw from '@ome/protocol/instrument.json' with { type: 'json' }`)
instead of reaching outside its own package with relative paths.

## Instrument configuration

`instrument.json` defines the single tradable instrument. It is the only place these values
are written down.

| Field                 | Meaning                                                                  |
|-----------------------|--------------------------------------------------------------------------|
| `symbol`              | Ticker, 1-16 characters `A-Z` / `0-9`.                                   |
| `name`                | Display name, non-empty.                                                 |
| `tickSize`            | Price increment as a decimal **string** (no binary floating point).      |
| `priceDecimals`       | Decimal places in a price, 0-8. `tickSize` must be exactly 10^-decimals. |
| `minPriceTicks`       | Lowest valid price, in ticks (at least 1).                               |
| `maxPriceTicks`       | Highest valid price, in ticks.                                           |
| `maxOrderQty`         | Largest quantity a single order may have (at least 1).                   |
| `referencePriceTicks` | The simulator's initial price anchor; between the min and max.           |

Every tick and quantity field must be a JSON integer, and `maxPriceTicks * maxOrderQty` must
not exceed 2^53 - 1 so that any notional is exact as a JavaScript number. Prices travel on
every wire as integer ticks (14250 = 142.50); only display code converts to decimals.

Loaders, which apply identical rules and fail loudly on a bad file:

- TypeScript: `shared/src/instrument.ts` (zod), validated when `@ome/shared` is imported.
- C++: `engine-service/Instrument.h` (nlohmann/json), read by `engine_service` at startup.

Price conversion (`parseDecimalToTicks`, `ticksToDecimalString`) lives in
`shared/src/price.ts` and `engine-service/Price.h`. Parsing accepts only digits with an
optional `.` and at least one fractional digit, and fails with one of `empty`,
`invalid-format`, `too-many-decimals` or `out-of-range` (checked in that order).

## Fixtures

Both test suites read these files, so the two implementations cannot drift:

- `fixtures/prices.json`: groups of price cases, each with its own `priceDecimals` and price
  range. `roundTrip` pairs must convert both ways exactly, `parse` inputs are accepted but not
  canonical, and `invalid` inputs must fail with the given error code.
- `fixtures/instrument-configs.json`: instrument configs with one defect each, which both
  loaders must reject.

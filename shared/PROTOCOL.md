# Public WebSocket protocol

The protocol between the browser and the gateway. The zod schemas in
[`src/protocol.ts`](src/protocol.ts) are the source of truth; this document explains them. The
gateway ↔ engine service protocol is separate (see
[`protocol/internal-protocol.md`](../protocol/internal-protocol.md)).

## Conventions

- One WebSocket at `/ws`. JSON **text** frames, exactly one message per frame. Every message is an
  object with a string `type`.
- Prices are integer **ticks** (`priceDecimals` 2: `14250` = 142.50). Quantities are integers.
  Money amounts (`cashTicks`, `pnlAtLastTicks`) are price ticks × quantity. Timestamps are
  milliseconds since the Unix epoch (UTC). Every number is a safe integer (|n| ≤ 2^53 − 1).
  Clients convert ticks for display with the `@ome/shared` price helpers, never with float maths.
- Client frames are at most **4096 bytes** of UTF-8 (`MAX_CLIENT_FRAME_BYTES`). Server frames have
  no fixed cap (a snapshot can hold hundreds of bars).
- Order IDs are assigned by the engine service, start at 1 and increase. `clientOrderId` is chosen
  by the client (a UUID fits): 1–36 characters from `A–Z a–z 0–9 _ -`.

### Unknown fields

- **Client → gateway: rejected.** Client messages are strict; an extra field makes the message
  invalid and the gateway answers `error` `badMessage`.
- **Gateway → client: stripped.** Extra fields are dropped when parsing, so an older web build
  keeps working against a newer gateway that adds fields.

An unknown `type` is invalid in both directions.

### Parsing

`parseClientMessage(text)` and `parseServerMessage(text)` never throw. They return
`{ ok: true, message }` or `{ ok: false, error: { code, detail } }`, where `code` is `tooLarge`
(client frames only), `invalidJson` or `invalidMessage`. `detail` describes what was expected and
never quotes the frame, so it is safe to log or send back (frames can contain a session token).

Schemas check shape and integers only. Instrument limits — quantity up to `maxOrderQty`, price
within `minPriceTicks`–`maxPriceTicks`, the price band around the last trade — are business rules:
a well-formed `placeOrder` that breaks them gets `orderReject`, not `badMessage`.

## Connection lifecycle

### Auth

1. The client opens `/ws` and sends `auth` with the session token from `POST /api/session` as its
   **first** message. The token is never put in the URL.
2. If the token is valid, the gateway sends `welcome`, then `snapshot` (default interval `15s`).
3. Any other first message gets `error` `authRequired` and the connection is closed. An invalid or
   expired token, or one issued for a previous engine instance, gets `error` `sessionExpired` and
   the connection is closed; the client must re-join (new name, new token). No `auth` within
   5 seconds also closes the connection.

`auth` after a successful auth is a `badMessage`.

### Snapshot, then updates

`snapshot` holds the connection's whole state: candles for its interval, daily stats, the trader's
open orders, recent fills and position. A client **replaces** all its state with each snapshot,
then applies updates in order:

- `candles`: bars that changed since the last update, keyed by `start`. A bar whose `start` the
  client already has replaces it; a newer one is appended. Updates are coalesced (at most one
  `candles` message per flush).
- `stats`, `position`: replace the previous value.
- `orderUpdate`: the full current view of one order, keyed by `orderId`. An order whose `status`
  is no longer `resting` leaves the open-orders list.
- `fill`: prepend to the fills list (newest first).
- `orderAck` / `orderReject`: replies to the client's own `placeOrder` / `cancelOrder`.

The gateway sends a new `snapshot` after `setInterval`, and also when a slow connection catches up
(instead of the backlog it dropped).

### Sequence numbers and gaps

Every server message has `seq`. It is 1 on the first message of a connection (`welcome`) and
increases by exactly one per message on that connection. A client tracks the last `seq`; if a
message arrives with any other value than last + 1, it has missed data and its state may be
wrong. It must discard its state, close the connection and reconnect; the fresh `auth` returns a
fresh `snapshot`. `seq` restarts at 1 on every connection.

### Keepalive

The client may send `ping`; the gateway answers `pong`. The gateway also uses WebSocket-level
ping/pong and closes a connection that misses a pong (every 30 s by default).

### Connection limits

- The upgrade request is refused with a plain HTTP status, before any WebSocket exists, when its
  `Origin` is missing or not on the gateway's allow-list (`403`), the gateway is at its total
  connection cap (`503`, default 500) or the client IP is at its cap (`429`, default 5).
- A frame larger than the limit (4096 bytes) closes the connection with code `1009`. A binary frame
  gets `error` `badMessage`.
- After an `auth`, every bad frame gets `error` `badMessage`; after 5 of them the connection is
  closed with code `1008`. Connections are also closed with `1008` after `authRequired` and
  `sessionExpired`.
- When the engine service restarts, every connection gets `error` `sessionExpired` and is closed.
- Order limits are per session, shared by all of its connections: 10 orders or cancels per second
  with bursts of 20, at most 50 open orders (resting plus awaiting the engine), and a price within
  10% of the last trade (or the reference price before the first trade). Each `cancelAll` cancel
  uses one of the rate limit's tokens.
- A successful `cancelOrder` has no direct reply: the order's `orderUpdate` with status
  `cancelled` reports it.

## Client → gateway

| `type`        | Fields                                                                                          | Notes                                     |
| ------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `auth`        | `token` string, 1–1024 chars                                                                    | Must be the first message.                |
| `placeOrder`  | `clientOrderId` string, `side` `buy`/`sell`, `qty` integer ≥ 1, `priceTicks` integer ≥ 1         | A limit order. Answered by `orderAck` or `orderReject` with the same `clientOrderId`. |
| `cancelOrder` | `orderId` integer ≥ 1                                                                           | Failure: `orderReject` with that `orderId`. Success: `orderUpdate` with status `cancelled`. |
| `cancelAll`   | —                                                                                               | Cancels each of the session's resting orders. |
| `setInterval` | `interval` `5s` / `15s` / `1m` / `5m`                                                           | Answered by a `snapshot` for that interval. |
| `ping`        | —                                                                                               | Answered by `pong`.                       |

## Gateway → client

Every message also carries `seq` (integer ≥ 1).

| `type`        | Fields                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `welcome`     | `you` {`traderId`, `name`}, `instrument` (the fields of `protocol/instrument.json`), `serverTime`          |
| `snapshot`    | `interval`, `candles` (bars, oldest first), `stats`, `openOrders` (order views), `fills` (newest first), `position` |
| `candles`     | `interval`, `bars` (updated or appended bars)                                                             |
| `stats`       | `last`, `open`, `high`, `low`, `change` (ticks, or all `null` before the instrument has ever traded)       |
| `orderAck`    | `clientOrderId`, `orderId`                                                                                |
| `orderReject` | exactly one of `clientOrderId` (rejected `placeOrder`) or `orderId` (rejected cancel), `reason`, `message` |
| `orderUpdate` | an order view                                                                                             |
| `fill`        | `orderId`, `side`, `priceTicks`, `qty`, `time`, `liquidity` `maker`/`taker`                               |
| `position`    | `netQty` (negative when short), `cashTicks`, `pnlAtLastTicks`, `fillCount`, `openOrderCount`              |
| `error`       | `code`, `message`                                                                                         |
| `pong`        | —                                                                                                         |

**Candle bar**: `{ start, open, high, low, close, volume, trades }`. `start` is aligned to the
interval in UTC (`start % INTERVAL_MS[interval] === 0`); prices are ticks, `volume` is total
quantity and `trades` the trade count. Intervals with no trades have no bar.

**Stats** are daily, resetting at 00:00 UTC: `open` is the first trade of the day, `high`/`low`
the extremes since, `change` = `last − open` (percentage change is derived by the client). Before
the first trade of the day, `open`/`high`/`low` equal `last`.

**Order view**: `orderId`, `side`, `priceTicks`, `originalQty`, `filledQty`, `remainingQty`,
`status` (`resting` / `filled` / `cancelled`), `placedAt`. An order filled on arrival is never
`resting` but still produces an `orderUpdate` with status `filled`.

**Position**: `cashTicks` is the cash flow from fills (sells add, buys subtract) and
`pnlAtLastTicks` = `cashTicks + netQty × last`.

### Error codes

| `code`           | Meaning                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `authRequired`   | A message other than `auth` arrived before authentication.                 |
| `sessionExpired` | The token is invalid, expired or from a previous engine instance. Re-join. |
| `rateLimited`    | Too many messages; slow down.                                              |
| `badMessage`     | The frame was too large, not JSON, or not a valid message.                 |

### Reject reasons

`orderReject.reason` is one of the codes below. [`src/reject-reasons.ts`](src/reject-reasons.ts)
exports `REJECT_REASON_TEXT`, the user-facing text for each; `orderReject.message` may add
specifics such as the configured limit (`"Too many open orders (limit 50)"`).

| `reason`                 | Meaning                                                    | Engine reason (internal protocol)   |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------- |
| `priceOutOfRange`        | Price outside the instrument's limits.                     | `InvalidPrice`, `PriceOutOfRange`   |
| `qtyOutOfRange`          | Quantity not between 1 and `maxOrderQty`.                  | `InvalidQuantity`, `QtyOutOfRange`  |
| `priceBand`              | Price too far from the last trade (gateway check).         | —                                   |
| `tooManyOpenOrders`      | The session has too many open orders.                      | —                                   |
| `rateLimited`            | The session's order rate limit was reached.                | —                                   |
| `duplicateClientOrderId` | A `placeOrder` reused a `clientOrderId` still in flight.   | —                                   |
| `unknownOrder`           | Cancel of an order that is not one of the session's resting orders. | `UnknownOrderId`           |
| `notOwner`               | Cancel of another trader's order.                          | `NotOwner`                          |
| `engineUnavailable`      | The engine service is disconnected.                        | —                                   |
| `internal`               | Any other failure.                                         | `DuplicateOrderId`, unknown values  |

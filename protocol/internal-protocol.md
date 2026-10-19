# Internal protocol

The private binary protocol between the **gateway** (Node) and the **engine service** (C++).
It runs over a single TCP connection that is never exposed to the internet. Version **1**.

Implementations, tested against the same byte fixtures in `fixtures/internal/`:

- C++: `engine-service/InternalProtocol.h` (messages, encoding) and
  `engine-service/FrameDecoder.h` (streaming decoder).
- TypeScript: `gateway/src/internal/protocol.ts`, `codec.ts` and `frame-decoder.ts`.

## Framing

Every message is one frame:

| Offset | Size | Field     | Meaning                                                            |
|--------|------|-----------|--------------------------------------------------------------------|
| 0      | 4    | `length`  | `u32`: number of bytes that follow this field (1 + payload size).  |
| 4      | 1    | `type`    | `u8`: message type code (tables below).                            |
| 5      | n    | `payload` | The message's fields, in the order listed, with no padding.        |

- All integers are **little-endian**. Signed integers are two's complement.
- Every message type has a **fixed** payload size, so `length` is fully determined by `type`.
- `length` may not exceed **256** (`kMaxFrameLength` / `MAX_FRAME_LENGTH`). Every current
  message is far smaller; the cap bounds how much a receiver buffers before rejecting a frame.
- Type codes `0x01`–`0x7F` are sent by the gateway; `0x81`–`0xFF` by the engine service. A
  receiver treats a code from the other direction as unknown.

### Field types

| Type   | Size | Used for                                                             |
|--------|------|----------------------------------------------------------------------|
| `u8`   | 1    | `side`, `aggressorSide`, `reason` (enums below)                      |
| `u16`  | 2    | `protocolVersion`                                                    |
| `u32`  | 4    | trader IDs                                                           |
| `u64`  | 8    | order IDs, `clientTag`, `eventSeq`, `engineInstanceId`               |
| `i64`  | 8    | prices (integer ticks), quantities, timestamps (ns since Unix epoch) |

Prices are integer ticks of the instrument (`instrument.json`: 14250 = 142.50). The wire allows
any `i64`, including negatives; range checks are the engine service's job, not the codec's.
Timestamps are `i64` nanoseconds since 1970-01-01T00:00:00Z.

### Enums

`side` / `aggressorSide`:

| Value | Meaning |
|-------|---------|
| 0     | Buy     |
| 1     | Sell    |

`reason` (in `OrderRejected`). Values 0–3 are the engine library's own `RejectReason` values;
16 and up are added by the engine service. Other values are invalid.

| Value | Name               | Meaning                                                        |
|-------|--------------------|----------------------------------------------------------------|
| 0     | `InvalidPrice`     | The engine rejected the price (not positive).                  |
| 1     | `InvalidQuantity`  | The engine rejected the quantity (not positive).               |
| 2     | `DuplicateOrderId` | The engine already has an order with this ID.                  |
| 3     | `UnknownOrderId`   | Cancel of an order that is not resting.                        |
| 16    | `NotOwner`         | Cancel from a trader who does not own the order.               |
| 17    | `PriceOutOfRange`  | Price outside the instrument's `minPriceTicks`–`maxPriceTicks`. |
| 18    | `QtyOutOfRange`    | Quantity not between 1 and the instrument's `maxOrderQty`.     |

## Gateway → engine service

| Code   | Message       | Payload | Fields (in wire order)                                                   |
|--------|---------------|---------|--------------------------------------------------------------------------|
| `0x01` | `Hello`       | 2       | `protocolVersion u16`                                                    |
| `0x02` | `SubmitOrder` | 29      | `clientTag u64`, `traderId u32`, `side u8`, `price i64`, `qty i64`       |
| `0x03` | `CancelOrder` | 20      | `clientTag u64`, `traderId u32`, `orderId u64`                           |
| `0x04` | `Heartbeat`   | 0       | —                                                                        |

- **`Hello`** must be the first frame on a connection.
- **`SubmitOrder`**: a new limit order. It carries no order ID: the engine service assigns one
  and returns it in `OrderAccepted`. IDs start at 1 and increase by one per accepted order;
  rejected submits do not use one. The engine service rejects a price outside the instrument's
  limits with `PriceOutOfRange`, and a quantity outside them with `QtyOutOfRange`. `clientTag` is an opaque value chosen by the gateway and
  echoed in `OrderAccepted` / `OrderRejected` so it can match replies to requests.
- **`CancelOrder`**: cancel a resting order on behalf of `traderId`. `clientTag` is echoed in
  an `OrderRejected` if the cancel fails: `NotOwner` if another trader owns the order (it is
  left untouched), or `UnknownOrderId` if it is not resting.
- **`Heartbeat`**: keeps the connection alive when there is nothing else to send.

## Engine service → gateway

| Code   | Message          | Payload | Fields (in wire order)                                                                                                                                  |
|--------|------------------|---------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| `0x81` | `HelloAck`       | 18      | `protocolVersion u16`, `engineInstanceId u64`, `serverTime i64`                                                                                         |
| `0x82` | `SnapshotBegin`  | 8       | `eventSeq u64`                                                                                                                                          |
| `0x83` | `SnapshotEnd`    | 8       | `eventSeq u64`                                                                                                                                          |
| `0x84` | `RestingOrder`   | 45      | `orderId u64`, `traderId u32`, `side u8`, `price i64`, `originalQty i64`, `remainingQty i64`, `acceptedAt i64`                                          |
| `0x85` | `TradeReplay`    | 57      | same fields as `Trade`                                                                                                                                  |
| `0x86` | `Trade`          | 57      | `eventSeq u64`, `ts i64`, `makerOrderId u64`, `takerOrderId u64`, `buyerTraderId u32`, `sellerTraderId u32`, `price i64`, `qty i64`, `aggressorSide u8` |
| `0x87` | `OrderAccepted`  | 53      | `eventSeq u64`, `ts i64`, `clientTag u64`, `orderId u64`, `traderId u32`, `side u8`, `price i64`, `qty i64`                                             |
| `0x88` | `OrderRejected`  | 37      | `eventSeq u64`, `ts i64`, `clientTag u64`, `orderId u64`, `traderId u32`, `reason u8`                                                                   |
| `0x89` | `OrderRested`    | 45      | `eventSeq u64`, `ts i64`, `orderId u64`, `traderId u32`, `side u8`, `price i64`, `remainingQty i64`                                                     |
| `0x8A` | `OrderCancelled` | 36      | `eventSeq u64`, `ts i64`, `orderId u64`, `traderId u32`, `cancelledQty i64`                                                                             |
| `0x8B` | `Heartbeat`      | 8       | `serverTime i64`                                                                                                                                        |

- **`HelloAck`**: reply to a valid `Hello`. `engineInstanceId` is random per process start, so
  the gateway can tell a reconnect to the same process from a restarted engine (whose order IDs
  and `eventSeq` start again). `serverTime` is the engine service's clock.
- **Live events** (`Trade`, `OrderAccepted`, `OrderRejected`, `OrderRested`, `OrderCancelled`)
  each carry an `eventSeq` that is **strictly increasing across the engine service's lifetime**
  (not per connection), and `ts`, the time the event happened.
  - `OrderAccepted`: a submit was accepted and assigned `orderId`. It may be followed by
    `Trade`s (as the taker) and then `OrderRested` if a remainder rests.
  - `OrderRejected`: a submit or cancel failed. `orderId` is 0 for a rejected submit (no ID was
    assigned), or the target order for a rejected cancel.
  - `Trade`: one fill, at the resting (maker) order's price. `aggressorSide` is the taker's side.
  - `OrderRested`: the order (or its unfilled remainder) is now resting in the book.
  - `OrderCancelled`: a resting order was cancelled; `cancelledQty` is what was still open.
- **`Heartbeat`**: keeps the connection alive; carries the engine service's clock.

### Snapshot

After `HelloAck`, the engine service sends the current state before any live event:

1. `SnapshotBegin`
2. one `RestingOrder` per resting order: `originalQty` as submitted, `remainingQty` still open,
   `acceptedAt` the time it was accepted. Bids come first, then asks; each side is in
   price-time order (best price first, then oldest first within a price);
3. one `TradeReplay` per retained recent trade, oldest first, each keeping the trade's original
   `eventSeq` and `ts`. The engine service retains trades for a configurable period
   (`--retention`, default 24 hours); older trades are not replayed;
4. `SnapshotEnd`.

`SnapshotBegin` and `SnapshotEnd` both carry the `eventSeq` of the **first live event that will
follow**. Every event with a smaller `eventSeq` is reflected in the snapshot; live events then
continue from that value without gaps or duplicates. `RestingOrder` and `TradeReplay` are only
valid between `SnapshotBegin` and `SnapshotEnd`.

## Connection lifecycle

1. The gateway connects and sends `Hello` with its `protocolVersion`.
2. If the version equals the engine service's, it replies `HelloAck` followed by the snapshot.
   On a mismatch, or if any other frame arrives before `Hello`, it closes the connection.
3. Both sides then exchange commands and events.

- **Heartbeats**: each side sends `Heartbeat` every second. The engine service closes the
  connection if it receives nothing from the gateway for 5 seconds (before or after the
  handshake); the gateway should do the same.
- **One gateway at a time**: while a gateway is connected, the engine service accepts and
  immediately closes any further connection. After a disconnect it accepts a new one.
- **Slow gateway**: if the gateway stops reading and the engine service has more than 8 MiB of
  output queued for it, the engine service drops the connection rather than buffer without bound.
  The connect-time snapshot, which can be larger, is allowed on top of the limit until it has
  been written.
- Events that happen while no gateway is connected are not queued; `eventSeq` still advances,
  and a reconnecting gateway catches up from the snapshot.

## Protocol errors

A receiver that sees any of the following closes the connection. Decoders report the first
error and ignore all later input.

| Error             | Condition                                                                         |
|-------------------|-----------------------------------------------------------------------------------|
| `frame-too-short` | `length` is 0 (no room for the type byte).                                        |
| `frame-too-large` | `length` exceeds 256. Detected as soon as the 4 length bytes arrive.              |
| `unknown-type`    | `type` is not a message the peer sends (including codes from the other direction). |
| `length-mismatch` | `length` ≠ 1 + the type's payload size. Detected from the 5-byte header alone.     |
| `invalid-enum`    | A `side`, `aggressorSide` or `reason` byte has no defined value.                  |
| `truncated`       | The input ended part way through a frame.                                         |

Receivers must handle frames split across reads and several frames in one read; both decoders
are tested one byte at a time and with every frame split at every offset.

## Fixtures

`fixtures/internal/<message>.hex` holds one encoded frame per message type: whitespace-separated
hex bytes, one field per line, with `#` comments naming each field and its value. The values
exercise the extremes of each wire type (`u64` max, `i64` min and max, `u32` max, negative
prices). The C++ (`tests/InternalProtocolFixtures.h`) and TypeScript
(`gateway/test/internal/fixtures.ts`) tests hold the same message values; each must encode them
to exactly these bytes and decode the bytes back to the same messages.

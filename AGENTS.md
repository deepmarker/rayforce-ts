# AGENTS.md

Typed asynchronous TCP IPC client for RayforceDB (wire format v3). Zero runtime dependencies: only
`node:` built-ins (`node:net`, `node:buffer`). Must run on Node 20+ and Bun.

## Commands

```sh
bun install --frozen-lockfile   # deps: only typescript + @types/node
bun run check                   # CI command: tsc build to dist/ + bun test (~1s)
bun run build                   # tsc -p tsconfig.json
bun test                        # unit tests only; integration file is skipped without RAYFORCE
bun run test:integration        # RAYFORCE=rayforce bun test test/integration.test.ts
bun run test:node               # builds, then runs scripts/smoke-node.mjs against real rayforce
RAYFORCE=/path/to/rayforce bun test   # run everything incl. integration with a specific binary
```

There is no linter or formatter config; `tsc` under `strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes` is the gate. `.github/workflows/check.yml` runs exactly `bun run check`.

Integration tests spawn isolated real `rayforce` processes on free loopback ports and always kill
them; they are `describe.skipIf(!process.env.RAYFORCE)` so `bun test` alone silently skips them
(15 pass / 6 skip in the default run, 4 more pass with `RAYFORCE` set).

## Layout

| File | Role |
| --- | --- |
| `src/value.ts` | Public value model (`Value` union, `Atom`/`Vector`/...), typed factories, error classes, epoch helpers |
| `src/codec.ts` | Wire format: tag tables, `encodeValue`/`decodeValue`, frame header encode/decode, delta-RLE decompression. Re-exports everything from `value.ts` |
| `src/reader.ts` | `ByteQueue`: chunked byte accumulator supporting async `read(n)`, one waiter at a time |
| `src/client.ts` | `RayClient`: connect + handshake, FIFO request queue, timeouts/abort, push dispatch, teardown |
| `src/multicast.ts` | `decodeMulticast`: unwraps `(upd topic sequence (quote payload))` |
| `src/index.ts` | Package root export; `./codec` is a separate subpath export |
| `test/peer.ts` | Fake server helper (`peer`, `handshake`, `readValue`, `reply`) used by `client.test.ts` |
| `test/server.rfl` | Rayfall fixture the integration test launches rayforce with |

Runtime code flows: `RayClient.request` -> `codec.encodeFrame` -> socket -> `ByteQueue` -> `decodeHeader` +
`decodePayload` -> resolve pending / `onPush`. The client is a single TCP connection with no request
IDs, so requests are strictly serialized (one active, the rest queued).

## Conventions and gotchas

- **ESM only, NodeNext resolution**: all relative imports must end in `.js`, including from `.ts`
  sources (`import ... from "./value.js"`). Tests import via `../src/index.js` too.
- **`Buffer` comes from `node:buffer`** explicitly, not the global. Keep browser-ish ports in mind.
- **Wire tags are deliberately asymmetric**: atoms are encoded as *negative* tags (`256 - tag`, e.g.
  i64 atom -> `0xfb`), vectors/lists/tables/dicts/lambdas use positive tags; `126` is null, `127` is
  a padded 8-byte error code, `101..103` are unary/binary/variadic builtins. Tag numbers are fixed by
  the Rayforce serializer and must match `src/store/serde.c` upstream; `DATE` widths differ between
  atoms (variable) and vectors (fixed via `widths`).
- **64-bit values are `bigint`**, never `number`: i64/timestamp/timespan atoms and
  `BigInt64Array` vectors. Rejecting lossy input (a `number` for an i64 atom) is intentional. Vectors
  must be passed as the wrong-typed array check in `arrays` (e.g. `i64` needs `BigInt64Array`).
- **Host byte order**: the codec refuses to operate on big-endian hosts (`littleEndian` check). Decoded
  numeric vectors are copied out of the receive buffer.
- **Null sentinels are preserved verbatim** in typed arrays (int minima, NaN), and typed-null atoms use
  `flags & 1` (`isTypedNull`). Do not "normalize" these to `null`; tests in `codec.test.ts` and
  `integration.test.ts` assert exact bytes/values.
- **Every protocol limit is validated before any I/O** in `RayClient.connect` so bad options throw
  synchronously-ish (`RangeError`) rather than after opening a socket. Keep that duplication
  (constructor + connect) in sync if adding limits.
- **Cancellation semantics**: aborting/timing out a *queued* request removes just that one; doing so to
  the *active* exchange closes the connection and rejects everything (a late response would otherwise be
  attributed to the next request). No retries, no reconnection, ever.
- **Push frames never fulfill a request**: only message type `2` resolves the active request; types `0`
  and `1` go to `onPush`. A throwing/rejecting push callback tears the connection down.
- **`call()` quotes every argument as data** by building `(name (quote arg) ...)`; use `symbol(x, false)`
  only when constructing low-level executable expressions. `query()` sends the source string as a
  string atom. Never interpolate source text into `call`.
- **Three message types matter**: `0` async (evaluated, never answered; sent by `post()`), `1` sync
  (sent by `request()`), `2` response. Only type `2` resolves a request. Rayforce evaluates async
  messages but sends nothing back, so "no reply" is correct behaviour, not a dropped connection.
- **`post()` bypasses the request FIFO by design**: async frames may be written while a request is in
  flight, and do not occupy a `maxPendingRequests` slot. `maxPostBytes` bounds only frames the socket
  has not accepted yet, so it binds on synchronous burst issuing, not on awaited one-at-a-time calls.
- **`decodeMulticast` returns `null` for unrelated pushes and throws `ProtocolError` for malformed
  envelopes**; payloads are never evaluated.
- **Error model**: local/protocol failures throw `ProtocolError`, `TimeoutError`, `ConnectionClosedError`;
  a remote top-level `error` value rejects with `RayError` carrying a short `code` only (the wire carries
  no diagnostic text).
- Codec and frame decoders must reject *all* malformed inputs (`codec.test.ts` asserts every truncated
  prefix throws, plus trailing bytes, ragged tables, >128 nesting). Add rejection paths rather than
  tolerating ambiguity.
- No comments explaining *what* the code does; existing comments are short `why` notes in
  sentence case with a trailing period, and docstrings use `/** ... */` on public API.
- Documentation lives in `README.md` (also shipped in the package) and is written as prose with no
  marketing tone; update it when changing public API or wire behavior.

## Testing approach

- `codec.test.ts` uses a round-trip table (`values`) plus exact-byte assertions; extend that table when
  adding a type.
- `client.test.ts` drives `RayClient` against `test/peer.ts` fake servers, covering fragmented writes,
  handshakes (incl. UTF-8 credential byte length), ordering, timeouts, aborts, compressed frames, and
  buffer limits. Prefer this over real-engine tests for protocol edge cases.
- `integration.test.ts` verifies the live engine (native tables, nanosecond timestamps, typed nulls,
  quoting semantics, multicast). Fixtures go in `test/server.rfl`; the rayforce process is started with
  `-c 1 -p host:port <fixture>`.
- `scripts/smoke-node.mjs` imports from `dist/` so it validates the built artifact under plain Node,
  not the TS sources.

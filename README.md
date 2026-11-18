# rayforce-ts

A typed asynchronous TCP IPC client for RayforceDB, for Node.js 20+ and Bun.
No native library, FFI, embedded engine, JSON or WebSocket transport is needed.
The client connects to an existing Rayforce process using wire format v3.

## Build and test

Development uses Bun and TypeScript:

```sh
git clone https://github.com/deepmarker/rayforce-ts.git
cd rayforce-ts
bun install --frozen-lockfile
bun run check
```

`check` builds the ESM package and declarations in `dist/`, then runs codec
and socket tests. Runtime code uses only Node standard-library modules.
Source files ship with the package so declaration maps support editor navigation.
There are no runtime package dependencies. This package is not yet published
to npm; build a local checkout before consuming it as a local dependency.

For real-engine tests, install `rayforce` on PATH:

```sh
bun run test:integration
bun run test:node
```

`RAYFORCE=/path/to/rayforce bun test` also runs the integration tests with a
specific build. Tests launch isolated Rayforce processes on free loopback
ports and always stop their own processes. Set `TMPDIR` to an existing
disk-backed task directory if your system's default temporary storage is
RAM-backed. The integration tests cover native tables, 64-bit precision,
typed nulls, data-safe function calls, errors and multicast delivery.
The Node smoke test uses the compiled package against another real server.

## Connect and query

Start a Rayforce server in another terminal:

```sh
rayforce -p 127.0.0.1:5015
```

```ts
import { RayClient, atom, symbol } from '@deepmarker/rayforce-ts';

const client = await RayClient.connect({
  host: '127.0.0.1',
  port: 5015,
  connectTimeoutMs: 5000,
  requestTimeoutMs: 5000,
});
try {
  const answer = await client.query('(+ 20 22)');
  // { kind: 'atom', type: 'i64', value: 42n, flags: 0 }

  const result = await client.call('+', [atom('i64', 20n), atom('i64', 22n)]);
  // Arguments are quoted data, including nested lists and symbols.

  // If the server has a quote_snapshot function:
  // await client.call('quote_snapshot', [symbol('BIN'), symbol('BTCUSDT')]);
} finally {
  client.close();
}
```

`query(source)` explicitly evaluates Rayfall source. `call(name, args)` builds
a typed call with each argument quoted as data; no source interpolation is
used. `request(value)` is the low-level synchronous IPC message operation
(the JavaScript API is asynchronous). It sends the exact typed expression
you provide, so it is also suitable for application-specific IPC dispatchers.

`post(value)` sends an asynchronous IPC message: the server evaluates it and
sends no reply, so it never waits for a round trip. This is the right
primitive for high-rate ingestion. The promise resolves once the frame is
handed to the socket and rejects if the connection fails first.

```ts
await client.post(atom("string", '(set counter 1)'));
// no reply is awaited; a later request observes the effect
```

Supply `user` and `password` in `connect` when the server requires them.
The wire v3 credential handshake is supported, including UTF-8 byte limits.
The transport is plain TCP. TLS, Unix-domain sockets, shared memory and RDMA
are not implemented.

## Typed values

All results retain their Rayforce type and attributes:

- Atoms: `{ kind: 'atom', type, value, flags }`.
- Vectors: `{ kind: 'vector', type, values, attrs }`.
- Lists: `{ kind: 'list', values, attrs }`.
- Tables: `{ kind: 'table', columns: [{ name, values }], attrs, schemaAttrs }`.
- Dictionaries: `{ kind: 'dict', keys, values, attrs }`.
- Null, error, lambda and builtin-function wire values are represented too.

`atom`, `symbol`, `vector`, `list`, `dict` and `table` construct values.
`symbol(name)` is quoted by default; `symbol(name, false)` is an executable
symbol for constructing a low-level expression.

I64, timestamp and timespan atoms are `bigint`; their vectors are
`BigInt64Array`. Narrow numeric vectors use the corresponding typed arrays,
and symbol/string vectors use string arrays. GUIDs are 16-byte `Uint8Array`
values. Text is UTF-8. Numeric vector data is copied on decode, so results
do not retain the receive buffer. Numeric typed arrays require a
little-endian JavaScript host; unsupported byte order is refused explicitly.

Typed-null atom flags are preserved (`isTypedNull` checks them). Vector null
sentinels remain in the original typed arrays: integer minima and floating
NaNs are not converted to JavaScript `null`. This also preserves exact raw
fixed-point values. Consumers decide how their schema maps those values.
Empty tables and lists remain distinct.

Rayforce timestamps count nanoseconds since 2000-01-01 UTC. `fromUnixNs` and
`toUnixNs` convert epochs without losing nanoseconds. No implicit JavaScript
Date conversion or numeric narrowing is performed.

The codec supports scalar/vector bool, U8, I16, I32, I64, F32, F64, date, time,
timestamp, timespan, GUID, symbol and string values, plus containers,
lambdas and named builtin functions. Index/opaque engine objects are refused.
A remote top-level error rejects the request with `RayError.code`; the basic
wire error carries a short code, not the engine's full diagnostic text.

## Server pushes and multicast

An async server frame never fulfills a pending request. Receive pushes with
`onPush`; use `decodeMulticast` to unwrap Rayforce's native
`(upd topic sequence (quote payload))` envelope without evaluating its data:

```ts
import { RayClient, atom, decodeMulticast } from '@deepmarker/rayforce-ts';

const client = await RayClient.connect({
  port: 5010,
  onPush(value) {
    const event = decodeMulticast(value);
    if (event) console.log(event.topic, event.sequence, event.payload);
  },
});
await client.call('.mc.sub', [atom('string', 'trades'), { kind: 'null' }]);
// Later:
await client.call('.mc.unsub', [atom('string', 'trades')]);
client.close();
```

`decodeMulticast` returns null for unrelated pushes and rejects malformed
multicast envelopes. Callbacks run in receive order. Async callback promises
are observed but are not awaited before reading the next frame. A thrown or
rejected push callback closes the connection. Reconnection, resubscription,
sequence-gap handling and snapshot recovery belong to the application; the
client never silently replays a request or presents a recovered feed as current.

## Deadlines and resource bounds

Requests share one TCP connection and are serialized because the protocol
has no request IDs. You may issue concurrent requests; each waits in a FIFO.
Its timeout starts when enqueued and includes queue time.

```ts
const controller = new AbortController();
const pending = client.query('(+ 1 2)', {
  signal: controller.signal,
  timeoutMs: 2000,
});
```

Cancelling or timing out an unsent queued request removes only that request.
Cancelling or timing out the active exchange closes the connection and rejects
all pending requests. That prevents a late response from being mistaken for
the next request's answer. Closing a connection does not guarantee that the
server stopped executing the request. Handshake deadlines include TCP
connection setup and authentication.

Defaults:

| Option | Default | Meaning |
| --- | --- | --- |
| `maxPayloadBytes` | 64 MiB | Maximum encoded or decompressed message body |
| `maxBufferedBytes` | Twice the payload limit plus 32 bytes | Receive backlog and queued request bytes, each bounded independently |
| `maxPendingRequests` | 64 | Active plus queued requests |
| `maxPostBytes` | The payload limit | Async post bytes the socket has not accepted yet |
| `connectTimeoutMs` | 5000 | TCP connection plus credential handshake |
| `requestTimeoutMs` | 5000 | Per-request deadline from enqueue |

The payload limit may be raised up to the protocol's 256 MiB body limit.
Delta/RLE-compressed responses are supported and bounded by the decompressed
limit. Outbound messages are uncompressed. Unknown versions, big-endian wire
frames, transport-upgrade records, malformed lengths, truncated messages,
trailing value data and nesting beyond 128 levels are refused.

## Protocol references

The implementation follows Rayforce's [native IPC documentation](https://rayforcedb.com/docs/storage/ipc/)
and its [serializer source](https://github.com/RayforceDB/rayforce/blob/main/src/store/serde.c).
Interoperability was checked against `rayforce-git 3.0.1.r264.g38fd4be3-1`
(wire v3). Compatibility is tied to the wire format; newer engine versions
that add unsupported value types or frame features are rejected explicitly.

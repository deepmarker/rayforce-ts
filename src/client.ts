import { createConnection, type Socket } from "node:net";
import { Buffer } from "node:buffer";
import { ByteQueue } from "./reader.js";
import { WIRE_VERSION, DEFAULT_MAX_BYTES, checkLimit, encodeFrame, decodeHeader, decodePayload } from "./codec.js";
import { atom, list, symbol, ProtocolError, RayError, TimeoutError, ConnectionClosedError, type Value } from "./value.js";

export interface ConnectOptions {
  host?: string;
  port: number;
  user?: string;
  password?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxPayloadBytes?: number;
  maxBufferedBytes?: number;
  maxPendingRequests?: number;
  signal?: AbortSignal;
  /** Async server frames (including multicast) never fulfill a pending request. */
  onPush?: (value: Value) => void | Promise<void>;
  onClose?: (reason: Error) => void;
}
export interface RequestOptions { timeoutMs?: number; signal?: AbortSignal }
interface Pending {
  frame: Buffer;
  resolve: (value: Value) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  active: boolean;
}
function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function positive(n: number, name: string): number {
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new RangeError(`${name} must be a positive bounded integer`);
  return n;
}

/** TCP wire-v3 client. No FFI, shared library, JSON or WebSocket transport. */
export class RayClient {
  private readonly reader: ByteQueue;
  private readonly requests: Pending[] = [];
  private active: Pending | undefined;
  private failure: Error | undefined;
  private ready = false;
  private readonly maxPayload: number;
  private readonly timeout: number;
  private readonly maxPending: number;
  private readonly maxBuffered: number;
  private queuedBytes = 0;
  private constructor(private readonly socket: Socket, private readonly options: ConnectOptions) {
    this.maxPayload = checkLimit(options.maxPayloadBytes ?? DEFAULT_MAX_BYTES);
    this.timeout = positive(options.requestTimeoutMs ?? 5000, "requestTimeoutMs");
    this.maxPending = positive(options.maxPendingRequests ?? 64, "maxPendingRequests");
    const buffered = positive(options.maxBufferedBytes ?? this.maxPayload * 2 + 32, "maxBufferedBytes");
    if (buffered < this.maxPayload + 16) throw new RangeError("Receive buffer must fit a complete frame");
    this.maxBuffered = buffered;
    this.reader = new ByteQueue(buffered);
    socket.on("data", b => { try { this.reader.push(b); } catch (e) { this.fail(errorOf(e)); } });
    socket.on("error", e => this.fail(e));
    socket.on("end", () => this.fail(new ConnectionClosedError("Peer closed the connection")));
    socket.on("close", () => this.fail(new ConnectionClosedError("Socket closed")));
  }
  static async connect(options: ConnectOptions): Promise<RayClient> {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new RangeError("Invalid TCP port");
    const connectTimeout = positive(options.connectTimeoutMs ?? 5000, "connectTimeoutMs");
    // Validate all resource limits before opening a socket.
    checkLimit(options.maxPayloadBytes ?? DEFAULT_MAX_BYTES);
    positive(options.requestTimeoutMs ?? 5000, "requestTimeoutMs");
    positive(options.maxPendingRequests ?? 64, "maxPendingRequests");
    const buffered = positive(options.maxBufferedBytes ?? (options.maxPayloadBytes ?? DEFAULT_MAX_BYTES) * 2 + 32, "maxBufferedBytes");
    if (buffered < (options.maxPayloadBytes ?? DEFAULT_MAX_BYTES) + 16) throw new RangeError("Receive buffer must fit a complete frame");
    options.signal?.throwIfAborted();
    const socket = createConnection({ host: options.host ?? "127.0.0.1", port: options.port });
    const client = new RayClient(socket, options);
    const timer = setTimeout(() => client.fail(new TimeoutError("Rayforce connect/handshake timed out")), connectTimeout);
    const abort = () => client.fail(errorOf(options.signal?.reason ?? new Error("Connection aborted")));
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const connected = () => { cleanup(); resolve(); };
        const failed = (e?: Error) => { cleanup(); reject(client.failure ?? e ?? new ConnectionClosedError()); };
        const cleanup = () => { socket.off("connect", connected); socket.off("error", failed); socket.off("close", failed); };
        socket.once("connect", connected); socket.once("error", failed); socket.once("close", failed);
      });
      socket.setNoDelay(true);
      socket.write(Buffer.from([WIRE_VERSION, 0]));
      const reply = await client.reader.read(2);
      if (reply[0] !== WIRE_VERSION) throw new ProtocolError("Server wire version differs from v3");
      if (reply[1] === 1) {
        if (options.password === undefined) throw new ProtocolError("Server requires credentials");
        if (options.password.includes("\0") || /[:\0]/.test(options.user ?? "")) throw new ProtocolError("Invalid credentials");
        const credentials = Buffer.from(`${options.user ?? ""}:${options.password}\0`, "utf8");
        if (credentials.length > 255) throw new ProtocolError("Credentials exceed 255 UTF-8 bytes");
        socket.write(Buffer.concat([Buffer.from([credentials.length]), credentials]));
        if ((await client.reader.read(1))[0] !== 0) throw new ProtocolError("Authentication rejected");
      } else if (reply[1] !== 0) throw new ProtocolError("Invalid handshake authentication byte");
      if (client.failure) throw client.failure;
      client.ready = true;
      void client.receive().catch(e => client.fail(errorOf(e)));
      return client;
    } catch (e) {
      client.fail(errorOf(e)); throw e;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    }
  }
  get closed(): boolean { return this.failure !== undefined; }
  close(): void { this.fail(new ConnectionClosedError()); }

  /** Timeout starts at enqueue time. An active cancellation closes the connection. */
  request(value: Value, options: RequestOptions = {}): Promise<Value> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.ready) return Promise.reject(new ConnectionClosedError("Handshake is incomplete"));
    if (this.requests.length >= this.maxPending) return Promise.reject(new ProtocolError("Pending request limit exceeded"));
    let frame: Buffer; let timeout: number;
    try {
      options.signal?.throwIfAborted();
      timeout = positive(options.timeoutMs ?? this.timeout, "timeoutMs");
      frame = encodeFrame(value, 1, this.maxPayload);
      if (this.queuedBytes + frame.length > this.maxBuffered) throw new ProtocolError("Queued request byte limit exceeded");
    } catch (e) { return Promise.reject(errorOf(e)); }
    return new Promise((resolve, reject) => {
      const pending: Pending = { frame, resolve, reject, active: false };
      pending.timer = setTimeout(() => this.cancel(pending, new TimeoutError()), timeout);
      if (options.signal) {
        pending.signal = options.signal;
        pending.abort = () => this.cancel(pending, errorOf(options.signal!.reason ?? new Error("Request aborted")));
        pending.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.requests.push(pending); this.queuedBytes += frame.length;
      if (pending.signal?.aborted) pending.abort?.();
      this.pump();
    });
  }
  /** Explicitly evaluate source. Use call() and typed values for data arguments. */
  query(source: string, options?: RequestOptions): Promise<Value> {
    return this.request(atom("string", source), options);
  }
  call(name: string, args: Value[] = [], options?: RequestOptions): Promise<Value> {
    if (!name || name.includes("\0")) return Promise.reject(new ProtocolError("Invalid function name"));
    return this.request(list([symbol(name, false), ...args.map(v => list([symbol("quote", false), v]))]), options);
  }
  private clean(pending: Pending): void {
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
  }
  private cancel(pending: Pending, reason: Error): void {
    const index = this.requests.indexOf(pending);
    if (index < 0) return;
    if (pending.active) { this.fail(reason); return; }
    this.requests.splice(index, 1); this.queuedBytes -= pending.frame.length;
    this.clean(pending); pending.reject(reason);
  }
  private pump(): void {
    if (this.failure || this.active || this.requests.length === 0) return;
    this.active = this.requests[0]!; this.active.active = true;
    this.socket.write(this.active.frame, e => { if (e) this.fail(e); });
  }
  private async receive(): Promise<void> {
    while (!this.failure) {
      const header = decodeHeader(await this.reader.read(16), this.maxPayload);
      const value = decodePayload(header, await this.reader.read(header.payloadBytes), this.maxPayload);
      if (header.type !== 2) {
        const handled = this.options.onPush?.(value);
        if (handled) void Promise.resolve(handled).catch(e => this.fail(errorOf(e)));
        continue;
      }
      const request = this.active;
      if (!request) throw new ProtocolError("Response without an active request");
      this.requests.shift(); this.queuedBytes -= request.frame.length;
      this.active = undefined; this.clean(request);
      if (value.kind === "error") request.reject(new RayError(value.code));
      else request.resolve(value);
      this.pump();
    }
  }
  private fail(reason: Error): void {
    if (this.failure) return;
    this.failure = reason; this.ready = false; this.reader.fail(reason); this.socket.destroy();
    this.active = undefined; this.queuedBytes = 0;
    for (const pending of this.requests.splice(0)) { this.clean(pending); pending.reject(reason); }
    try { this.options.onClose?.(reason); } catch { /* User notifications cannot prevent teardown. */ }
  }
}

import { Buffer } from "node:buffer";
import { ProtocolError, length, type Value, type ScalarType, type Cells, type Atom, type Vector } from "./value.js";
export * from "./value.js";

export const WIRE_VERSION = 3;
export const HEADER_BYTES = 16;
export const PROTOCOL_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export type MessageType = 0 | 1 | 2;
export interface Header { type: MessageType; flags: number; payloadBytes: number }
const tags: Record<ScalarType, number> = {
  bool: 1, u8: 2, i16: 3, i32: 4, i64: 5, f32: 6, f64: 7,
  date: 8, time: 9, timestamp: 10, guid: 11, symbol: 12, string: 13, timespan: 16,
};
const names = Object.fromEntries(Object.entries(tags).map(([name, tag]) => [tag, name])) as Record<number, ScalarType>;
const widths: Partial<Record<ScalarType, number>> = {
  bool: 1, u8: 1, i16: 2, i32: 4, f32: 4, date: 4, time: 4,
  i64: 8, f64: 8, timestamp: 8, timespan: 8, guid: 16,
};
const arrays: Partial<Record<ScalarType, new (buffer: ArrayBuffer) => Cells>> = {
  bool: Uint8Array, u8: Uint8Array, i16: Int16Array, i32: Int32Array,
  date: Int32Array, time: Int32Array, i64: BigInt64Array, f32: Float32Array,
  f64: Float64Array, timestamp: BigInt64Array, timespan: BigInt64Array,
};
const utf8 = new TextDecoder("utf-8", { fatal: true });
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function fail(message: string): never { throw new ProtocolError(message); }
function byte(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 255) fail("Invalid attribute or flags byte");
  return n;
}
export function checkLimit(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0 || n > PROTOCOL_MAX_BYTES) fail("Invalid payload limit");
  return n;
}
function cstring(text: string): Buffer {
  if (text.includes("\0")) fail("Symbols and function names cannot contain NUL");
  return Buffer.from(text + "\0", "utf8");
}
function count(n: number): Buffer {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b;
}
function integer(v: unknown, low: number, high: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < low || v > high) fail("Integer atom out of range");
  return v;
}
function scalar(a: Atom): Buffer {
  const v = a.value;
  if (a.type === "symbol") {
    if (typeof v !== "string") fail("Symbol must be text");
    return cstring(v);
  }
  if (a.type === "string") {
    if (typeof v !== "string") fail("String atom must be text");
    const b = Buffer.from(v, "utf8"); return Buffer.concat([count(b.length), b]);
  }
  if (a.type === "guid") {
    if (!(v instanceof Uint8Array) || v.length !== 16) fail("GUID must contain 16 bytes");
    return Buffer.from(v);
  }
  const b = Buffer.alloc(widths[a.type]!);
  switch (a.type) {
    case "bool": if (typeof v !== "boolean") fail("Boolean atom must be boolean"); b[0] = v ? 1 : 0; break;
    case "u8": b[0] = integer(v, 0, 255); break;
    case "i16": b.writeInt16LE(integer(v, -32768, 32767)); break;
    case "i32": case "date": case "time": b.writeInt32LE(integer(v, -2147483648, 2147483647)); break;
    case "i64": case "timestamp": case "timespan":
      if (typeof v !== "bigint" || v < -(1n << 63n) || v >= (1n << 63n)) fail("64-bit atoms require an in-range bigint");
      b.writeBigInt64LE(v); break;
    case "f32": case "f64":
      if (typeof v !== "number") fail("Floating atom must be a number");
      if (a.type === "f32") b.writeFloatLE(v); else b.writeDoubleLE(v); break;
  }
  return b;
}
function vectorBody(v: Vector): Buffer {
  if (v.type === "symbol" || v.type === "string") {
    if (!Array.isArray(v.values) || v.values.some(x => typeof x !== "string")) fail("Text vector requires strings");
    return Buffer.concat((v.values as string[]).map(s => {
      if (v.type === "symbol") return cstring(s);
      const b = Buffer.from(s, "utf8"); return Buffer.concat([count(b.length), b]);
    }));
  }
  if (v.type === "guid") {
    if (!Array.isArray(v.values) || v.values.some(x => !(x instanceof Uint8Array) || x.length !== 16)) fail("GUID vector requires 16-byte values");
    return Buffer.concat((v.values as Uint8Array[]).map(x => Buffer.from(x)));
  }
  const ctor = arrays[v.type];
  if (!ctor || !(v.values instanceof ctor) || !littleEndian) fail("Vector has the wrong typed array or unsupported host byte order");
  const data = v.values as Exclude<Cells, string[] | Uint8Array[]>;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function encodeValue(value: Value, maxBytes = DEFAULT_MAX_BYTES): Buffer {
  checkLimit(maxBytes);
  let total = 0;
  const chunks: Buffer[] = [];
  const add = (b: Buffer) => {
    total += b.length;
    if (total > maxBytes) fail("Encoded value exceeds payload limit");
    chunks.push(b);
  };
  const visit = (v: Value, depth: number): void => {
    if (depth > 128) fail("Value nesting exceeds 128 levels");
    switch (v.kind) {
      case "null": add(Buffer.from([126])); return;
      case "error": {
        if (!/^[\x20-\x7e]{1,7}$/.test(v.code)) fail("Error code requires 1 to 7 ASCII characters");
        const b = Buffer.alloc(9); b[0] = 127; b.write(v.code, 1, "ascii"); add(b); return;
      }
      case "atom": add(Buffer.from([256 - tags[v.type], byte(v.flags)])); add(scalar(v)); return;
      case "vector": add(Buffer.from([tags[v.type], byte(v.attrs)])); add(count(v.values.length)); add(vectorBody(v)); return;
      case "list":
        add(Buffer.from([0, byte(v.attrs)])); add(count(v.values.length));
        for (const child of v.values) visit(child, depth + 1); return;
      case "dict":
        if (length(v.keys) !== length(v.values)) fail("Dictionary key/value lengths differ");
        add(Buffer.from([99, byte(v.attrs)])); visit(v.keys, depth + 1); visit(v.values, depth + 1); return;
      case "table": {
        const seen = new Set<string>();
        for (const col of v.columns) {
          if (seen.has(col.name)) fail("Duplicate table column name"); seen.add(col.name);
          if (length(col.values) !== length(v)) fail("Table columns have unequal lengths");
        }
        add(Buffer.from([98, byte(v.attrs)]));
        visit({ kind: "vector", type: "symbol", values: v.columns.map(c => c.name), attrs: v.schemaAttrs }, depth + 1);
        visit({ kind: "list", values: v.columns.map(c => c.values), attrs: 0 }, depth + 1); return;
      }
      case "function": add(Buffer.from([{ unary: 101, binary: 102, variadic: 103 }[v.type]])); add(cstring(v.name)); return;
      case "lambda":
        if (Boolean(v.attrs & 1) !== (v.closure !== undefined)) fail("Lambda closure flag does not match closure");
        add(Buffer.from([100, byte(v.attrs)])); visit(v.params, depth + 1); visit(v.body, depth + 1);
        if (v.closure !== undefined) visit(v.closure, depth + 1); return;
    }
  };
  visit(value, 0);
  return Buffer.concat(chunks, total);
}

class Cursor {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(n: number): Buffer {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.bytes.length - this.offset) fail("Truncated value");
    const b = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return b;
  }
  u8(): number { return this.take(1)[0]!; }
  len(width = 1): number {
    const n = this.take(8).readBigInt64LE();
    if (n < 0n || n > BigInt(Math.floor((this.bytes.length - this.offset) / width))) fail("Invalid collection length");
    return Number(n);
  }
  text(bytes: Buffer): string {
    try { return utf8.decode(bytes); } catch { return fail("Invalid UTF-8 text"); }
  }
  cstring(): string {
    const end = this.bytes.indexOf(0, this.offset);
    if (end < 0) fail("Unterminated symbol or function name");
    const b = this.take(end - this.offset); this.take(1); return this.text(b);
  }
  value(depth = 0): Value {
    if (depth > 128) fail("Value nesting exceeds 128 levels");
    const raw = this.u8(); const tag = raw > 127 ? raw - 256 : raw;
    if (tag === 126) return { kind: "null" };
    if (tag === 127) {
      const b = this.take(8); const nul = b.indexOf(0);
      return { kind: "error", code: b.subarray(0, nul < 0 ? 8 : nul).toString("ascii") };
    }
    if (tag >= 101 && tag <= 103) return { kind: "function", type: ({101:"unary",102:"binary",103:"variadic"} as const)[tag as 101], name: this.cstring() };
    const attrs = this.u8();
    if (tag === 98) {
      const schema = this.value(depth + 1); const cols = this.value(depth + 1);
      if (schema.kind !== "vector" || schema.type !== "symbol" || cols.kind !== "list") fail("Malformed table schema");
      const keys = schema.values as string[];
      if (keys.length !== cols.values.length || new Set(keys).size !== keys.length) fail("Malformed table columns");
      const columns = keys.map((name, i) => {
        const values = cols.values[i]!;
        if (values.kind !== "vector" && values.kind !== "list") fail("Table column is not a vector or list");
        return { name, values };
      });
      if (columns.some(c => length(c.values) !== (columns[0]?.values.values.length ?? 0))) fail("Ragged table");
      return { kind: "table", columns, attrs, schemaAttrs: schema.attrs };
    }
    if (tag === 99) {
      const keys = this.value(depth + 1); const values = this.value(depth + 1);
      if (length(keys) !== length(values)) fail("Malformed dictionary lengths");
      return { kind: "dict", keys, values, attrs };
    }
    if (tag === 100) {
      const params = this.value(depth + 1); const body = this.value(depth + 1);
      return attrs & 1 ? { kind: "lambda", params, body, attrs, closure: this.value(depth + 1) }
        : { kind: "lambda", params, body, attrs };
    }
    if (tag === 0) {
      const n = this.len(); const values: Value[] = [];
      for (let i = 0; i < n; i++) values.push(this.value(depth + 1));
      return { kind: "list", values, attrs };
    }
    const type = names[Math.abs(tag)];
    if (!type) fail(`Unsupported Rayforce type tag ${tag}`);
    if (tag < 0) {
      let value: Atom["value"];
      if (type === "symbol") value = this.cstring();
      else if (type === "string") value = this.text(this.take(this.len()));
      else if (type === "guid") value = Uint8Array.from(this.take(16));
      else {
        const b = this.take(widths[type]!);
        switch (type) {
          case "bool": value = b[0] !== 0; break;
          case "u8": value = b[0]!; break;
          case "i16": value = b.readInt16LE(); break;
          case "i32": case "date": case "time": value = b.readInt32LE(); break;
          case "i64": case "timestamp": case "timespan": value = b.readBigInt64LE(); break;
          case "f32": value = b.readFloatLE(); break;
          default: value = b.readDoubleLE();
        }
      }
      return { kind: "atom", type, value, flags: attrs };
    }
    const n = this.len(widths[type] ?? 1);
    let values: Cells;
    if (type === "symbol" || type === "string") {
      const strings: string[] = [];
      for (let i = 0; i < n; i++) strings.push(type === "symbol" ? this.cstring() : this.text(this.take(this.len())));
      values = strings;
    } else if (type === "guid") {
      const guids: Uint8Array[] = [];
      for (let i = 0; i < n; i++) guids.push(Uint8Array.from(this.take(16)));
      values = guids;
    } else {
      if (!littleEndian) fail("Unsupported host byte order");
      const b = this.take(n * widths[type]!);
      const copied = Uint8Array.from(b);
      const ctor = arrays[type]!; values = new ctor(copied.buffer);
    }
    return { kind: "vector", type, values, attrs };
  }
}

export function decodeValue(bytes: Uint8Array, maxBytes = DEFAULT_MAX_BYTES): Value {
  checkLimit(maxBytes);
  if (bytes.byteLength > maxBytes) fail("Value exceeds payload limit");
  const cursor = new Cursor(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const value = cursor.value();
  if (cursor.offset !== bytes.byteLength) fail("Trailing bytes after value");
  return value;
}
export function encodeFrame(value: Value, type: MessageType = 1, maxBytes = DEFAULT_MAX_BYTES): Buffer {
  if (![0, 1, 2].includes(type)) fail("Invalid message type");
  const body = encodeValue(value, maxBytes);
  const h = Buffer.alloc(16); h.writeUInt32LE(0xcefadefa); h[4] = WIRE_VERSION; h[7] = type; h.writeBigInt64LE(BigInt(body.length), 8);
  return Buffer.concat([h, body]);
}
export function decodeHeader(bytes: Uint8Array, maxBytes = DEFAULT_MAX_BYTES): Header {
  checkLimit(maxBytes);
  if (bytes.byteLength !== 16) fail("Frame header must contain 16 bytes");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.readUInt32LE() !== 0xcefadefa || b[4] !== WIRE_VERSION || b[6] !== 0) fail("Unsupported frame prefix, wire version or byte order");
  if ((b[5]! & ~0x0f) !== 0 || b[7]! > 2) fail("Unsupported frame flags or message type");
  const n = b.readBigInt64LE(8);
  if (n <= 0n || n > BigInt(maxBytes)) fail("Invalid frame payload size");
  return { type: b[7] as MessageType, flags: b[5]!, payloadBytes: Number(n) };
}
export function decodePayload(header: Header, bytes: Uint8Array, maxBytes = DEFAULT_MAX_BYTES): Value {
  checkLimit(maxBytes);
  if (bytes.byteLength !== header.payloadBytes || bytes.byteLength > maxBytes) fail("Frame payload length mismatch");
  if (!(header.flags & 1)) return decodeValue(bytes, maxBytes);
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 5) fail("Truncated compressed payload");
  const size = b.readUInt32LE();
  if (size === 0 || size > maxBytes) fail("Invalid decompressed size");
  const out = Buffer.alloc(size); let si = 4; let di = 0;
  const put = (delta: number) => { out[di] = ((di ? out[di - 1]! : 0) + delta) & 255; di++; };
  while (si < b.length && di < size) {
    const run = b.readInt8(si++);
    if (run === 0) fail("Invalid zero-length compressed run");
    const n = Math.abs(run);
    if (di + n > size) fail("Compressed run exceeds output");
    if (run > 0) {
      if (si >= b.length) fail("Missing compressed run value");
      const d = b[si++]!; for (let i = 0; i < n; i++) put(d);
    } else {
      if (si + n > b.length) fail("Truncated compressed literal");
      for (let i = 0; i < n; i++) put(b[si++]!);
    }
  }
  if (di !== size || si !== b.length) fail("Compressed size mismatch or trailing data");
  return decodeValue(out, maxBytes);
}

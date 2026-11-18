import { describe, test, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { encodeValue, decodeValue, encodeFrame, decodeHeader, decodePayload,
  atom, symbol, vector, list, dict, table, type Value } from "../src/codec.js";

const values: Value[] = [
  { kind: "null" }, { kind: "error", code: "type" },
  atom("bool", true), atom("u8", 255), atom("i16", -300), atom("i32", -12345),
  atom("i64", 9007199254740993n), atom("i64", -(1n << 63n), 1),
  atom("f32", 1.25), atom("f64", NaN, 1), atom("date", 20000), atom("time", 1234),
  atom("timestamp", 848000000000000001n), atom("timespan", -123456789n),
  atom("guid", Uint8Array.from({ length: 16 }, (_, i) => i)),
  symbol("BIN"), atom("string", "héllo\0世界"),
  vector("bool", new Uint8Array([1, 0])), vector("u8", new Uint8Array([0, 255])),
  vector("i16", new Int16Array([-1, 300])), vector("i32", new Int32Array([-1, 100000])),
  vector("i64", new BigInt64Array([9007199254740993n, -(1n << 63n)])),
  vector("timestamp", new BigInt64Array([848000000000000001n])),
  vector("timespan", new BigInt64Array([-1n, 2n])),
  vector("date", new Int32Array([0, -1])), vector("time", new Int32Array([2, 3])),
  vector("f32", new Float32Array([1.25, NaN])), vector("f64", new Float64Array([-0, 2.5, NaN])),
  vector("symbol", ["BIN", "BTCUSDT", "世界"]), vector("string", ["a\0b", "", "é"]),
  vector("guid", [new Uint8Array(16)]),
  list([atom("i64", 1n), symbol("value")]),
  dict(vector("symbol", ["one", "two"]), list([atom("i64", 1n), { kind: "null" }])),
  table([{ name: "timestamp", values: vector("timestamp", new BigInt64Array([848000000000000001n])) },
    { name: "venue", values: vector("symbol", ["BIN"]) }]),
  { kind: "function", type: "unary", name: "count" },
  { kind: "function", type: "binary", name: "+" },
  { kind: "function", type: "variadic", name: "list" },
  { kind: "lambda", params: vector("symbol", ["x"]), body: symbol("x"), attrs: 0 },
];

describe("wire v3 codec", () => {
  test("round trips typed values, flags, exact integers, UTF-8 and tables", () => {
    for (const value of values) {
      const bytes = encodeValue(value);
      expect(encodeValue(decodeValue(bytes))).toEqual(bytes);
    }
    expect([...encodeValue(atom("i64", 1n))]).toEqual([251, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect([...encodeValue(symbol("x"))]).toEqual([244, 32, 120, 0]);
  });
  test("rejects every truncated prefix and extra trailing data", () => {
    for (const value of values) {
      const bytes = encodeValue(value);
      for (let i = 0; i < bytes.length; i++) expect(() => decodeValue(bytes.subarray(0, i))).toThrow();
      expect(() => decodeValue(Buffer.concat([bytes, Buffer.from([0])]))).toThrow();
    }
  });
  test("refuses bad lengths, tags, nesting, ragged tables and lossy input", () => {
    const huge = Buffer.alloc(10); huge[0] = 5; huge.writeBigInt64LE(1n << 50n, 2);
    expect(() => decodeValue(huge)).toThrow();
    expect(() => decodeValue(Buffer.from([97, 0]))).toThrow();
    expect(() => encodeValue(atom("i64", 9007199254740992))).toThrow();
    expect(() => encodeValue(symbol("bad\0symbol"))).toThrow();
    expect(() => encodeValue(vector("i64", new Float64Array([1])))).toThrow();
    expect(() => encodeValue(table([{ name: "a", values: vector("i64", new BigInt64Array(1)) },
      { name: "b", values: vector("i64", new BigInt64Array(2)) }]))).toThrow();
    let nested: Value = { kind: "null" };
    for (let i = 0; i < 140; i++) nested = list([nested]);
    expect(() => encodeValue(nested)).toThrow();
    expect(() => encodeValue(atom("string", "too long"), 5)).toThrow();
  });
  test("validates frame boundaries, wire versions, byte order and limits", () => {
    const frame = encodeFrame(atom("i64", 42n), 2);
    const h = decodeHeader(frame.subarray(0, 16));
    expect(h).toEqual({ type: 2, flags: 0, payloadBytes: 10 });
    expect(decodePayload(h, frame.subarray(16))).toEqual(atom("i64", 42n));
    for (const [offset, value] of [[0, 0], [4, 2], [6, 1], [7, 3], [5, 128]]) {
      const changed = Buffer.from(frame.subarray(0, 16)); changed[offset!] = value!;
      expect(() => decodeHeader(changed)).toThrow();
    }
    expect(() => decodeHeader(frame.subarray(0, 16), 5)).toThrow();
    expect(() => decodePayload(h, frame.subarray(17))).toThrow();
  });
  test("decodes delta/RLE frames and rejects expansion overruns and suffixes", () => {
    // Uncompressed: null (126). One delta run: count=1, value=126.
    const b = Buffer.from([1, 0, 0, 0, 1, 126]);
    expect(decodePayload({ type: 2, flags: 1, payloadBytes: b.length }, b)).toEqual({ kind: "null" });
    for (const bad of [Buffer.from([1,0,0,0,2,126]), Buffer.from([1,0,0,0,1]),
      Buffer.from([1,0,0,0,255]), Buffer.from([1,0,0,0,0]), Buffer.concat([b, Buffer.from([0])])]) {
      expect(() => decodePayload({ type: 2, flags: 1, payloadBytes: bad.length }, bad)).toThrow();
    }
    const huge = Buffer.from(b); huge.writeUInt32LE(1000);
    expect(() => decodePayload({ type: 2, flags: 1, payloadBytes: huge.length }, huge, 100)).toThrow();
  });
});

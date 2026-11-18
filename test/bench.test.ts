import { describe, test, expect } from "bun:test";
import { encodeValue, decodeValue, vector } from "../src/codec.js";

const rows = 10_000;

function best(rounds: number, run: () => unknown): number {
  let fastest = Infinity;
  for (let i = 0; i < rounds; i++) {
    const started = process.hrtime.bigint();
    run();
    const elapsed = Number(process.hrtime.bigint() - started) / rows;
    if (elapsed < fastest) fastest = elapsed;
  }
  return fastest;
}

const text = (type: "symbol" | "string") => vector(type, Array.from({ length: rows }, (_, i) => `SYM${i % 64}`));

// Budgets are roughly double the current cost; they catch a return to per-element decodes (78ns/elem) without flaking.
const cases: Array<{ name: string; value: ReturnType<typeof text> | ReturnType<typeof vector>; decode: number; encode: number }> = [
  { name: "symbol", value: text("symbol"), decode: 60, encode: 120 },
  { name: "string", value: text("string"), decode: 170, encode: 150 },
  { name: "guid", value: vector("guid", Array.from({ length: rows }, (_, i) => Uint8Array.from({ length: 16 }, (_, k) => (i + k) & 0xff))), decode: 90, encode: 70 },
  { name: "i64", value: vector("i64", new BigInt64Array(rows).fill(7n)), decode: 200, encode: 20 },
];

describe.skipIf(process.env.RAYFORCE_BENCH === "0")("text and guid codec stay linear", () => {
  for (const { name, value, decode, encode } of cases) {
    const bytes = encodeValue(value);
    test(`${name} decodes within ${decode}ns per element`, () => {
      expect(best(20, () => decodeValue(bytes))).toBeLessThan(decode);
    });
    test(`${name} encodes within ${encode}ns per element`, () => {
      expect(best(20, () => encodeValue(value))).toBeLessThan(encode);
    });
  }
  test("repeated symbols share decoded instances on small vectors", () => {
    const decoded = decodeValue(encodeValue(vector("symbol", ["BTCUSDT", "BTCUSDT", "BIN"])));
    expect(decoded.values).toEqual(["BTCUSDT", "BTCUSDT", "BIN"]);
    expect(decoded.values[0]).toBe(decoded.values[1]);
  });
});

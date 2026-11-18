import { test, expect } from "bun:test";
import { decodeMulticast, list, symbol, atom } from "../src/index.js";
test("multicast unwraps quoted data, never executable payloads", () => {
  const payload = list([symbol("count", false), atom("i64", 1n)]);
  const event = list([symbol("upd", false), atom("string", "trades"), atom("i64", 42n), list([symbol("quote", false), payload])]);
  expect(decodeMulticast(event)).toEqual({ topic: "trades", sequence: 42n, payload });
  expect(decodeMulticast(atom("string", "other push"))).toBeNull();
  event.values[3] = payload;
  expect(() => decodeMulticast(event)).toThrow("quoted");
});

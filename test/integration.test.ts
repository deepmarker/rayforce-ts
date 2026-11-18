import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { RayClient, atom, symbol, vector, list, RayError, decodeMulticast, type Value } from "../src/index.js";

const enabled = Boolean(process.env.RAYFORCE);
describe.skipIf(!enabled)("native Rayforce integration", () => {
  let process_: ChildProcess;
  let client: RayClient;
  let output = "";
  const pushes: Value[] = [];
  beforeAll(async () => {
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    process_ = spawn(process.env.RAYFORCE!, ["-c", "1", "-p", `127.0.0.1:${port}`, fileURLToPath(new URL("server.rfl", import.meta.url))],
      { stdio: ["ignore", "pipe", "pipe"] });
    process_.stdout!.on("data", b => { output += b; }); process_.stderr!.on("data", b => { output += b; });
    let startupError: Error | undefined;
    process_.on("error", e => { startupError = e; });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (process_.exitCode !== null) throw new Error(output);
      try { client = await RayClient.connect({ port, connectTimeoutMs: 200, onPush: v => { pushes.push(v); } }); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    throw new Error(`Rayforce did not start: ${output}`);
  });
  afterAll(async () => {
    client?.close();
    if (process_ && process_.exitCode === null && process_.signalCode === null) {
      const done = once(process_, "exit"); process_.kill("SIGTERM");
      const timer = setTimeout(() => process_.kill("SIGKILL"), 2000);
      try { await done; } finally { clearTimeout(timer); }
    }
  });
  test("queries preserve native table types, nulls and nanoseconds", async () => {
    const result = await client.query("sample");
    expect(result.kind).toBe("table"); if (result.kind !== "table") throw new Error("table expected");
    expect(result.columns.map(c => c.name)).toEqual(["venue", "instrument", "ts", "price", "quantity"]);
    expect(result.columns[2]!.values).toMatchObject({ kind: "vector", type: "timestamp" });
    const ns = (result.columns[2]!.values.values as BigInt64Array)[0]!;
    expect(ns % 1000000000n).toBe(123456789n);
    expect([...result.columns[4]!.values.values as BigInt64Array]).toEqual([-(1n << 63n), 9007199254740993n]);
    expect((await client.query("0Nl"))).toMatchObject({ kind: "atom", type: "i64", flags: 1 });
  });
  test("typed calls quote data symbols and lists instead of evaluating them", async () => {
    expect(await client.call("+", [atom("i64", 20n), atom("i64", 22n)])).toMatchObject({ type: "i64", value: 42n });
    expect(await client.call("echo", [symbol("BIN")])).toMatchObject({ type: "symbol", value: "BIN" });
    const data = list([symbol("count", false), vector("i64", new BigInt64Array([1n,2n,3n,4n]))]);
    expect(await client.call("count", [data])).toMatchObject({ type: "i64", value: 2n });
  });
  test("remote errors leave subsequent calls usable", async () => {
    await expect(client.query('(+ 1 "text")')).rejects.toBeInstanceOf(RayError);
    expect(await client.query("(+ 1 2)")).toMatchObject({ type: "i64", value: 3n });
  });
  test("async posts are evaluated without a reply and keep the connection usable", async () => {
    await client.query("(set posted 0)");
    await Promise.all(Array.from({ length: 100 }, () => client.post(atom("string", "(set posted 1)"))));
    expect(await client.query("posted")).toMatchObject({ type: "i64", value: 1n });
    expect(await client.query("(+ 1 1)")).toMatchObject({ type: "i64", value: 2n });
    await client.post(atom("string", '(+ 1 "bad")'));
    expect(await client.query("(+ 2 2)")).toMatchObject({ type: "i64", value: 4n });
  });
  test("native multicast pushes are received separately from responses", async () => {
    await client.call(".mc.sub", [atom("string", "ipc-test"), { kind: "null" }]);
    await client.call(".mc.pub", [symbol("ipc-test"), atom("i64", 123n)]);
    const deadline = Date.now() + 1000;
    while (pushes.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(pushes.length).toBeGreaterThan(0);
    const event = pushes[0]!;
    expect(event.kind).toBe("list");
    expect(decodeMulticast(event)).toMatchObject({ topic: "ipc-test", sequence: expect.any(BigInt),
      payload: { kind: "atom", type: "i64", value: 123n } });
    await client.call(".mc.unsub", [atom("string", "ipc-test")]);
  });
});

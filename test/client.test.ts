import { test, expect } from "bun:test";
import { RayClient, atom, vector, TimeoutError, RayError } from "../src/index.js";
import { encodeFrame, encodeValue } from "../src/codec.js";
import { peer, handshake, readValue, reply } from "./peer.js";

test("fragmented handshake and frames, ordered concurrent requests, interleaved pushes", async () => {
  const pushes: unknown[] = [];
  const server = await peer(async (socket, reader) => {
    await handshake(socket, reader);
    const a = await readValue(reader);
    reply(socket, atom("string", "push"), 0);
    const frame = encodeFrame(a, 2);
    for (let i = 0; i < frame.length; i += 3) socket.write(frame.subarray(i, i + 3));
    reply(socket, await readValue(reader));
  });
  const client = await RayClient.connect({ port: server.port, onPush: value => { pushes.push(value); } });
  try {
    const [a, b] = await Promise.all([client.request(atom("i64", 1n)), client.request(atom("i64", 2n))]);
    expect(a).toEqual(atom("i64", 1n)); expect(b).toEqual(atom("i64", 2n));
    expect(pushes).toEqual([atom("string", "push")]);
    expect(server.errors).toEqual([]);
  } finally { client.close(); await server.close(); }
});

test("password handshake uses UTF-8 byte length and rejects denied authentication", async () => {
  const server = await peer(async (socket, reader) => {
    expect([...await reader.read(2)]).toEqual([3, 0]); socket.write(Buffer.from([3, 1]));
    const n = (await reader.read(1))[0]!;
    expect((await reader.read(n)).toString()).toBe("u:é\0"); socket.write(Buffer.from([0]));
    reply(socket, await readValue(reader));
  });
  const client = await RayClient.connect({ port: server.port, user: "u", password: "é" });
  try { expect(await client.request(atom("i64", 3n))).toEqual(atom("i64", 3n)); expect(server.errors).toEqual([]); }
  finally { client.close(); await server.close(); }
  const denied = await peer(async (socket, reader) => {
    await reader.read(2); socket.write(Buffer.from([3, 1]));
    await reader.read((await reader.read(1))[0]!); socket.write(Buffer.from([1]));
  });
  try { await expect(RayClient.connect({ port: denied.port, password: "wrong" })).rejects.toThrow("rejected"); }
  finally { await denied.close(); }
});

test("an active timeout closes the connection and rejects queued calls", async () => {
  const server = await peer(async (socket, reader) => { await handshake(socket, reader); await readValue(reader); });
  const client = await RayClient.connect({ port: server.port, requestTimeoutMs: 30 });
  try {
    const results = await Promise.allSettled([client.query("slow"), client.query("next")]);
    expect(results.every(r => r.status === "rejected" && r.reason instanceof TimeoutError)).toBe(true);
    expect(client.closed).toBe(true);
  } finally { client.close(); await server.close(); }
});

test("cancelling a queued call leaves the active exchange synchronized", async () => {
  const server = await peer(async (socket, reader) => {
    await handshake(socket, reader); const first = await readValue(reader);
    await new Promise(resolve => setTimeout(resolve, 15)); reply(socket, first);
    reply(socket, await readValue(reader));
  });
  const client = await RayClient.connect({ port: server.port });
  try {
    const first = client.query("first"); const controller = new AbortController();
    const queued = client.query("cancel", { signal: controller.signal });
    const cancelled = queued.catch(e => e);
    controller.abort(new Error("cancelled"));
    expect((await cancelled).message).toBe("cancelled");
    expect(await first).toEqual(atom("string", "first"));
    expect(await client.query("last")).toEqual(atom("string", "last"));
    expect(client.closed).toBe(false);
  } finally { client.close(); await server.close(); }
});

test("active abort and truncated response tear down pending requests", async () => {
  const server = await peer(async (socket, reader) => {
    await handshake(socket, reader); await readValue(reader);
  });
  const client = await RayClient.connect({ port: server.port });
  const controller = new AbortController();
  try {
    const pending = client.query("slow", { signal: controller.signal });
    const cancelled = pending.catch(e => e); controller.abort(new Error("stop"));
    expect((await cancelled).message).toBe("stop"); expect(client.closed).toBe(true);
  } finally { client.close(); await server.close(); }
  const broken = await peer(async (socket, reader) => {
    await handshake(socket, reader); await readValue(reader);
    socket.end(encodeFrame(atom("i64", 1n), 2).subarray(0, 20));
  });
  const c = await RayClient.connect({ port: broken.port });
  try { await expect(c.query("x")).rejects.toThrow(); expect(c.closed).toBe(true); }
  finally { c.close(); await broken.close(); }
});

test("remote error codes do not poison the next response", async () => {
  const server = await peer(async (socket, reader) => {
    await handshake(socket, reader); await readValue(reader); reply(socket, { kind: "error", code: "type" });
    await readValue(reader); reply(socket, atom("i64", 4n));
  });
  const client = await RayClient.connect({ port: server.port });
  try {
    await expect(client.query("bad")).rejects.toBeInstanceOf(RayError);
    expect(await client.query("good")).toEqual(atom("i64", 4n));
  } finally { client.close(); await server.close(); }
});

test("limits queued calls and bounds silent handshakes", async () => {
  const server = await peer(async (socket, reader) => { await handshake(socket, reader); await readValue(reader); });
  const client = await RayClient.connect({ port: server.port, maxPendingRequests: 1 });
  try {
    const active = client.query("slow").catch(e => e);
    await expect(client.query("extra")).rejects.toThrow("limit"); client.close(); expect(await active).toBeInstanceOf(Error);
  } finally { client.close(); await server.close(); }
  const silent = await peer(async () => {});
  try { await expect(RayClient.connect({ port: silent.port, connectTimeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError); }
  finally { await silent.close(); }
});

test("compressed responses are decoded across fragmented input", async () => {
  const wanted = vector("i64", new BigInt64Array([1n, 9007199254740993n, -5n]));
  const server = await peer(async (socket, reader) => {
    await handshake(socket, reader); await readValue(reader);
    const body = encodeValue(wanted);
    const deltas = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i++) deltas[i] = (body[i]! - (i ? body[i-1]! : 0)) & 255;
    const chunks: Buffer[] = [];
    for (let i = 0; i < deltas.length; i += 127) {
      const part = deltas.subarray(i, i+127); chunks.push(Buffer.from([256-part.length]), part);
    }
    const size = Buffer.alloc(4); size.writeUInt32LE(body.length);
    const compressed = Buffer.concat([size, ...chunks]);
    const h = encodeFrame(wanted, 2).subarray(0, 16); h[5] = 1; h.writeBigInt64LE(BigInt(compressed.length), 8);
    const frame = Buffer.concat([h, compressed]);
    for (let i = 0; i < frame.length; i += 5) socket.write(frame.subarray(i, i+5));
  });
  const client = await RayClient.connect({ port: server.port });
  try { expect(await client.query("compressed")).toEqual(wanted); }
  finally { client.close(); await server.close(); }
});

test("oversized responses and queued request bytes fail within configured bounds", async () => {
  const blocked = await peer(async (socket, reader) => { await handshake(socket, reader); await readValue(reader); });
  const limited = await RayClient.connect({ port: blocked.port, maxPayloadBytes: 64, maxBufferedBytes: 80 });
  try {
    const active = limited.query("x".repeat(40)).catch(e => e);
    await expect(limited.query("y".repeat(40))).rejects.toThrow("byte limit");
    limited.close(); expect(await active).toBeInstanceOf(Error);
  } finally { limited.close(); await blocked.close(); }
  const malicious = await peer(async (socket, reader) => {
    await handshake(socket, reader); await readValue(reader);
    const h = encodeFrame(atom("i64", 1n), 2).subarray(0, 16); h.writeBigInt64LE(65n, 8); socket.write(h);
  });
  const client = await RayClient.connect({ port: malicious.port, maxPayloadBytes: 64 });
  try { await expect(client.query("x")).rejects.toThrow("payload size"); expect(client.closed).toBe(true); }
  finally { client.close(); await malicious.close(); }
});

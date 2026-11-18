import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { ByteQueue } from "../src/reader.js";
import { decodeHeader, decodePayload, encodeFrame, type Value } from "../src/codec.js";
export async function peer(handler: (socket: Socket, reader: ByteQueue) => Promise<void>) {
  const sockets = new Set<Socket>();
  const errors: unknown[] = [];
  const server = createServer(socket => {
    sockets.add(socket); const reader = new ByteQueue(2 * 1024 * 1024);
    socket.on("data", b => { try { reader.push(b); } catch (e) { reader.fail(e as Error); } });
    socket.on("error", e => reader.fail(e));
    socket.on("close", () => { sockets.delete(socket); reader.fail(new Error("closed")); });
    void handler(socket, reader).catch(e => { errors.push(e); socket.destroy(); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { port, errors, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }};
}
export async function handshake(socket: Socket, reader: ByteQueue) {
  await reader.read(2); socket.write(Uint8Array.from([3]));
  await new Promise(resolve => setTimeout(resolve, 1)); socket.write(Uint8Array.from([0]));
}
export async function readValue(reader: ByteQueue): Promise<Value> {
  const h = decodeHeader(await reader.read(16));
  return decodePayload(h, await reader.read(h.payloadBytes));
}
export function reply(socket: Socket, value: Value, type: 0 | 1 | 2 = 2) { socket.write(encodeFrame(value, type)); }

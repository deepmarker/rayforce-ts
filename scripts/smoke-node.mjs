import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { RayClient, atom, symbol } from "../dist/index.js";
const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const server = spawn(process.env.RAYFORCE ?? "rayforce", ["-c", "1", "-p", `127.0.0.1:${port}`], { stdio: "ignore" });
let startupError; server.on("error", error => { startupError = error; });
let client;
try {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (server.exitCode !== null) throw new Error("Rayforce exited before listening");
    try { client = await RayClient.connect({ port, connectTimeoutMs: 200 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(client, "Rayforce did not start");
  assert.equal((await client.query("(+ 20 22)")).value, 42n);
  assert.equal((await client.call("+", [atom("i64", 9007199254740993n), atom("i64", 1n)])).value, 9007199254740994n);
  assert.equal((await client.call("type", [symbol("BIN")])).value, "sym");
  console.log("PASS compiled Node package against native Rayforce IPC");
} finally {
  client?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const done = once(server, "exit"); server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
    try { await done; } finally { clearTimeout(timer); }
  }
}

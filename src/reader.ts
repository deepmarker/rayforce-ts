import { Buffer } from "node:buffer";
import { ProtocolError } from "./value.js";

/** One framing consumer, chunked input; no repeated concatenation of partial frames. */
export class ByteQueue {
  private chunks: Buffer[] = [];
  private head = 0;
  private offset = 0;
  private size = 0;
  private waiter: { bytes: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  private error: Error | undefined;
  constructor(private readonly maxBuffered: number) {}
  push(bytes: Buffer): void {
    if (this.error || bytes.length === 0) return;
    if (this.size + bytes.length > this.maxBuffered) throw new ProtocolError("Receive buffer limit exceeded");
    this.chunks.push(bytes); this.size += bytes.length; this.drain();
  }
  fail(error: Error): void {
    if (this.error) return;
    this.error = error; this.chunks = []; this.head = 0; this.offset = 0; this.size = 0;
    this.waiter?.reject(error); this.waiter = undefined;
  }
  read(bytes: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    if (this.waiter) return Promise.reject(new ProtocolError("Concurrent framing reads"));
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxBuffered) return Promise.reject(new ProtocolError("Invalid read length"));
    return new Promise((resolve, reject) => { this.waiter = { bytes, resolve, reject }; this.drain(); });
  }
  private drain(): void {
    const w = this.waiter;
    if (!w || this.size < w.bytes) return;
    const first = this.chunks[this.head]!;
    let out: Buffer;
    if (first.length - this.offset >= w.bytes) {
      out = first.subarray(this.offset, this.offset + w.bytes); this.offset += w.bytes;
      if (this.offset === first.length) { this.head++; this.offset = 0; }
    } else {
      out = Buffer.allocUnsafe(w.bytes); let written = 0;
      while (written < w.bytes) {
        const b = this.chunks[this.head]!;
        const n = Math.min(w.bytes - written, b.length - this.offset);
        b.copy(out, written, this.offset, this.offset + n);
        this.offset += n; written += n;
        if (this.offset === b.length) { this.head++; this.offset = 0; }
      }
    }
    this.size -= w.bytes;
    if (this.head > 64 || this.head === this.chunks.length) { this.chunks = this.chunks.slice(this.head); this.head = 0; }
    this.waiter = undefined; w.resolve(out);
  }
}

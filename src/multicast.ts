import { ProtocolError, type Value } from "./value.js";

export interface MulticastEvent { topic: string; sequence: bigint; payload: Value }
/** Unwrap the wire's (upd topic sequence (quote payload)) without evaluating it. */
export function decodeMulticast(value: Value): MulticastEvent | null {
  if (value.kind !== "list") return null;
  const [head, topic, sequence, body] = value.values;
  if (head?.kind !== "atom" || head.type !== "symbol" || head.value !== "upd") return null;
  if (value.values.length !== 4 || topic?.kind !== "atom" || topic.type !== "string" || typeof topic.value !== "string"
      || sequence?.kind !== "atom" || sequence.type !== "i64" || typeof sequence.value !== "bigint"
      || body?.kind !== "list" || body.values.length !== 2) throw new ProtocolError("Malformed multicast envelope");
  const [quote, payload] = body.values;
  if (quote?.kind !== "atom" || quote.type !== "symbol" || quote.value !== "quote" || !payload) {
    throw new ProtocolError("Multicast payload is not quoted data");
  }
  return { topic: topic.value, sequence: sequence.value, payload };
}

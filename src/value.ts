export type NumericType = "bool" | "u8" | "i16" | "i32" | "i64" | "f32" | "f64"
  | "date" | "time" | "timestamp" | "timespan";
export type ScalarType = NumericType | "guid" | "symbol" | "string";
export type Scalar = boolean | number | bigint | string | Uint8Array;
export type Cells = Uint8Array | Int16Array | Int32Array | BigInt64Array
  | Float32Array | Float64Array | string[] | Uint8Array[];
export interface Atom { kind: "atom"; type: ScalarType; value: Scalar; flags: number }
export interface Vector { kind: "vector"; type: ScalarType; values: Cells; attrs: number }
export interface List { kind: "list"; values: Value[]; attrs: number }
export interface Dict { kind: "dict"; keys: Value; values: Value; attrs: number }
export interface Table { kind: "table"; columns: Array<{ name: string; values: Vector | List }>; attrs: number; schemaAttrs: number }
export interface Lambda { kind: "lambda"; params: Value; body: Value; closure?: Value; attrs: number }
export interface Callable { kind: "function"; type: "unary" | "binary" | "variadic"; name: string }
export type Value = Atom | Vector | List | Dict | Table | Lambda | Callable
  | { kind: "null" } | { kind: "error"; code: string };

export class ProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "ProtocolError"; }
}
export class RayError extends Error {
  constructor(readonly code: string) { super(`Rayforce returned ${code}`); this.name = "RayError"; }
}
export class TimeoutError extends Error {
  constructor(message = "Rayforce request timed out") { super(message); this.name = "TimeoutError"; }
}
export class ConnectionClosedError extends Error {
  constructor(message = "Rayforce connection is closed") { super(message); this.name = "ConnectionClosedError"; }
}

export interface ScalarValues {
  bool: boolean; u8: number; i16: number; i32: number; i64: bigint;
  f32: number; f64: number; date: number; time: number;
  timestamp: bigint; timespan: bigint; guid: Uint8Array;
  symbol: string; string: string;
}
export function atom<T extends ScalarType>(type: T, value: ScalarValues[T], flags = 0): Atom {
  return { kind: "atom", type, value, flags };
}
/** Quoted by default so a symbol used as a call argument stays data. */
export function symbol(value: string, quoted = true): Atom {
  return atom("symbol", value, quoted ? 0x20 : 0);
}
export function list(values: Value[]): List { return { kind: "list", values, attrs: 0 }; }
export function vector(type: ScalarType, values: Cells, attrs = 0): Vector {
  return { kind: "vector", type, values, attrs };
}
export function table(columns: Table["columns"]): Table {
  return { kind: "table", columns, attrs: 0, schemaAttrs: 3 };
}
export function dict(keys: Value, values: Value): Dict {
  return { kind: "dict", keys, values, attrs: 0 };
}
export function length(value: Value): number {
  switch (value.kind) {
    case "vector": case "list": return value.values.length;
    case "table": return value.columns[0]?.values.values.length ?? 0;
    case "dict": return length(value.keys);
    default: return 1;
  }
}
export function isTypedNull(value: Value): boolean {
  return value.kind === "null" || (value.kind === "atom" && (value.flags & 1) !== 0);
}
/** Epoch helpers keep all nanoseconds; JavaScript Date conversion is left to callers. */
export const UNIX_TO_RAY_NS = 946684800000000000n;
export function fromUnixNs(ns: bigint): bigint { return ns - UNIX_TO_RAY_NS; }
export function toUnixNs(ns: bigint): bigint { return ns + UNIX_TO_RAY_NS; }

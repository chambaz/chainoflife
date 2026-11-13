export const HEX32 = /^0x[0-9a-f]{64}$/;
export const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export function isHex32(value: unknown): value is string {
  return typeof value === "string" && HEX32.test(value);
}

export function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

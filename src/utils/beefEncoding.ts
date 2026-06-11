import { Utils } from '@bsv/sdk';

/** Encode a BEEF byte array as a base64 string for JSON transport. */
export function encodeBeef(beef: number[]): string {
  return Utils.toBase64(beef);
}

/** Decode a base64 BEEF string back to a byte array. */
export function decodeBeef(beefBase64: string): number[] {
  return Utils.toArray(beefBase64, 'base64');
}

// Reads the token metadata an OrdinalsP2PKH locking script carries:
// <inscription envelope> <P2PKH> OP_RETURN <metadata JSON>. Pure JS so it also works
// where @bsv/sdk is mocked; parses what the SDK produces from hex, where everything after
// a top-level OP_RETURN is one chunk holding the raw bytes, push prefix included.

const OP_RETURN = 0x6a;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

/** The payload of the single push at the start of `bytes`, or null. */
function firstPush(bytes: number[]): number[] | null {
  const [op] = bytes;
  let start: number;
  let length: number;
  if (op >= 1 && op < OP_PUSHDATA1) {
    [start, length] = [1, op];
  } else if (op === OP_PUSHDATA1) {
    [start, length] = [2, bytes[1]];
  } else if (op === OP_PUSHDATA2) {
    [start, length] = [3, bytes[1] | (bytes[2] << 8)];
  } else if (op === OP_PUSHDATA4) {
    [start, length] = [5, (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16)) + bytes[4] * 2 ** 24];
  } else {
    return null;
  }
  return start + length <= bytes.length ? bytes.slice(start, start + length) : null;
}

/** The metadata object after the script's trailing OP_RETURN, or null if it has none. */
export function tokenMetadata(script: { chunks: Array<{ op: number; data?: number[] }> }): Record<string, unknown> | null {
  const last = script.chunks[script.chunks.length - 1];
  if (last?.op !== OP_RETURN || !last.data) return null;
  const payload = firstPush(last.data);
  if (!payload) return null;
  try {
    const metadata: unknown = JSON.parse(Buffer.from(payload).toString('utf8'));
    return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The lootTableId the script's metadata names, or null. */
export function inscribedLootTableId(script: { chunks: Array<{ op: number; data?: number[] }> }): string | null {
  const lootTableId = tokenMetadata(script)?.lootTableId;
  return typeof lootTableId === 'string' ? lootTableId : null;
}

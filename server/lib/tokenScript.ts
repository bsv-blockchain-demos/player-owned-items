// Reads what an OrdinalsP2PKH locking script carries:
// <inscription envelope: bsv-20 JSON {p, op, amt, id}> <P2PKH> OP_RETURN <metadata JSON>. Pure JS so it also works
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

type ParsedScript = { chunks: Array<{ op: number; data?: number[] }> };

const parseObject = (data: number[]): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** The bsv-20 inscription JSON in the script's ord envelope (chunks 2 and 6), or null. */
function inscription(script: ParsedScript): Record<string, unknown> | null {
  const [, , marker, , , , body] = script.chunks;
  if (!marker?.data || !body?.data || Buffer.from(marker.data).toString('utf8') !== 'ord') return null;
  return parseObject(body.data);
}

/** The amount of a bsv-20 transfer inscription, or null if the script carries none. */
export function transferAmount(script: ParsedScript): number | null {
  const ins = inscription(script);
  return ins?.op === 'transfer' && Number.isInteger(ins.amt) ? (ins.amt as number) : null;
}

/** The asset id a bsv-20 transfer inscription names, or null. */
export function inscribedAssetId(script: ParsedScript): string | null {
  const ins = inscription(script);
  return ins?.op === 'transfer' && typeof ins.id === 'string' ? ins.id : null;
}

/** A token's BSV-21 asset id: its deploy+mint outpoint as txid_vout. Every transfer carries it unchanged. */
export function mintAssetId(mintOutpoint: string | undefined): string | null {
  return mintOutpoint ? mintOutpoint.replace('.', '_') : null;
}

/** The metadata object after the script's trailing OP_RETURN, or null if it has none. */
export function tokenMetadata(script: ParsedScript): Record<string, unknown> | null {
  const last = script.chunks[script.chunks.length - 1];
  if (last?.op !== OP_RETURN || !last.data) return null;
  const payload = firstPush(last.data);
  return payload ? parseObject(payload) : null;
}

/** The lootTableId the script's metadata names, or null. */
export function inscribedLootTableId(script: ParsedScript): string | null {
  const lootTableId = tokenMetadata(script)?.lootTableId;
  return typeof lootTableId === 'string' ? lootTableId : null;
}

// A parsed OrdinalsP2PKH transfer script for route tests that mock @bsv/sdk: toHex() for
// the locked-to-key check, chunks in the layout the real SDK parses (see
// _tests/materialTransfer.test.ts) for the amount and the OP_RETURN metadata.

const bytes = (text: string) => [...Buffer.from(text, 'utf8')];

/** One script push of `data`, as it sits in the raw bytes after a top-level OP_RETURN. */
const pushed = (data: number[]) =>
  data.length < 0x4c ? [data.length, ...data]
    : data.length < 0x100 ? [0x4c, data.length, ...data]
      : [0x4d, data.length & 0xff, data.length >> 8, ...data];

export function inscribedScript(hex: string, amt: number, metadata: Record<string, unknown>) {
  return {
    toHex: () => hex,
    chunks: [
      { op: 0 }, { op: 0x63 }, { op: 3, data: bytes('ord') }, { op: 0x51 },
      { op: 18, data: bytes('application/bsv-20') }, { op: 0 },
      { op: 1, data: bytes(JSON.stringify({ p: 'bsv-20', op: 'transfer', amt, id: 'ANY_0' })) },
      { op: 0x68 },
      { op: 0x6a, data: pushed(bytes(JSON.stringify({ app: 'monsterbattle', type: 'ord', ...metadata }))) },
    ],
  };
}

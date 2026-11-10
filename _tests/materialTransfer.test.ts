// Parses real OrdinalsP2PKH scripts: the route tests mock script chunks, so this pins
// transferAmount to the layout the SDK actually produces.
import { PrivateKey, LockingScript } from '@bsv/sdk';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { voutOf } from '@server/lib/materialUnits';
import { tokenMetadata, transferAmount, inscribedAssetId, mintAssetId } from '@server/lib/tokenScript';

const pubKey = PrivateKey.fromRandom().toPublicKey().toString();
const metadata = { name: 'material_token', lootTableId: 'common_wood', tier: 1 };
// Round-trip through hex, as scripts arrive from a parsed BEEF.
const parsed = (script: LockingScript) => LockingScript.fromHex(script.toHex());

describe('transferAmount', () => {
  it('reads the amount of a transfer inscription', () => {
    const script = new OrdinalsP2PKH().lock(pubKey, 'TX_0', metadata, 'transfer', 7);
    expect(transferAmount(parsed(script))).toBe(7);
  });

  it('rejects a deploy+mint inscription', () => {
    const script = new OrdinalsP2PKH().lock(pubKey, '', metadata, 'deploy+mint', 7);
    expect(transferAmount(parsed(script))).toBeNull();
  });

  it('rejects a script with no inscription', () => {
    expect(transferAmount(LockingScript.fromASM('OP_DUP OP_HASH160 ' + '00'.repeat(20) + ' OP_EQUALVERIFY OP_CHECKSIG'))).toBeNull();
  });
});

describe('voutOf', () => {
  it.each([
    ['TX.0', 0],
    ['TX.12', 12],
    ['OTHER.0', null],
    ['TX.00', null],
    ['TX.01', null],
    ['TX.-1', null],
    ['TX.1.2', null],
    ['TX', null],
  ])('%s -> %s', (outpoint, expected) => {
    expect(voutOf(outpoint, 'TX')).toBe(expected);
  });
});

describe('tokenMetadata', () => {
  it('reads the OP_RETURN metadata of a transfer', () => {
    const script = new OrdinalsP2PKH().lock(pubKey, 'TX_0', metadata, 'transfer', 7);
    expect(tokenMetadata(parsed(script))).toEqual({ app: 'monsterbattle', type: 'ord', ...metadata });
  });

  it('reads metadata long enough to need OP_PUSHDATA2', () => {
    const long = { ...metadata, description: 'x'.repeat(300) }; // 414 bytes: length bytes 0x9e 0x01 (asymmetric, so byte order matters)
    const script = new OrdinalsP2PKH().lock(pubKey, 'TX_0', long, 'transfer', 1);
    expect(tokenMetadata(parsed(script))).toEqual(expect.objectContaining({ lootTableId: 'common_wood', description: long.description }));
  });

  it('returns null for a script without trailing metadata', () => {
    expect(tokenMetadata(LockingScript.fromASM('OP_DUP OP_HASH160 ' + '00'.repeat(20) + ' OP_EQUALVERIFY OP_CHECKSIG'))).toBeNull();
  });

  it.each([
    ['non-JSON', 'not json'],
    ['a JSON array', '[1,2]'],
  ])('returns null when the OP_RETURN data is %s', (_label, text) => {
    const data = Buffer.from(text, 'utf8');
    // OP_RETURN + one push, the shape the SDK parses into a single raw-remainder chunk
    const hex = '6a' + data.length.toString(16).padStart(2, '0') + data.toString('hex');
    expect(tokenMetadata(LockingScript.fromHex(hex))).toBeNull();
  });
});

describe('inscribedAssetId', () => {
  it('reads the id of a transfer inscription', () => {
    const script = new OrdinalsP2PKH().lock(pubKey, 'MINTTX_0', metadata, 'transfer', 7);
    expect(inscribedAssetId(parsed(script))).toBe('MINTTX_0');
  });

  it('returns null for a deploy+mint (it has no id)', () => {
    const script = new OrdinalsP2PKH().lock(pubKey, '', metadata, 'deploy+mint', 7);
    expect(inscribedAssetId(parsed(script))).toBeNull();
  });
});

describe('mintAssetId', () => {
  it('is the BSV-21 id form of the mint outpoint', () => {
    expect(mintAssetId('abc.0')).toBe('abc_0');
  });

  it('is null without a recorded mint', () => {
    expect(mintAssetId(undefined)).toBeNull();
  });
});

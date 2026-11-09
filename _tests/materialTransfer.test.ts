// Parses real OrdinalsP2PKH scripts: the route tests mock script chunks, so this pins
// transferAmount to the layout the SDK actually produces.
import { PrivateKey, LockingScript } from '@bsv/sdk';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { transferAmount, voutOf } from '@server/lib/materialUnits';

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

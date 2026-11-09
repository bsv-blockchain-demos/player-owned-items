// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'u1'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: jest.fn(async () => ({ enqueue })) }));

const findOne = jest.fn();
const insertOne = jest.fn(async () => ({ insertedId: 'MATERIAL_TOKEN_OID' }));
// Inventory units are claimed with updateMany, then deleted (consumed) or unset (released).
const updateMany = jest.fn(async (_filter: any, _update: any) => ({ modifiedCount: 2 }));
const deleteMany = jest.fn(async (_filter: any) => ({ deletedCount: 2 }));
jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    materialTokensCollection: { findOne, insertOne },
    userInventoryCollection: { updateMany, deleteMany },
  })),
}));

jest.mock('@server/lib/serverWallet', () => ({ getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID') }));
jest.mock('@shared/overlayFunctions', () => ({ broadcastTX: jest.fn(async () => ({ txid: 'MINTTX' })) }));
jest.mock('@shared/beefEncoding', () => ({ decodeBeef: jest.fn(() => [1, 2, 3]), encodeBeef: jest.fn(() => 'BEEF_B64') }));
jest.mock('@shared/tokenDerivation', () => ({ generateNonce: jest.fn(() => 'NONCE'), deriveRecipientKey: jest.fn(async () => 'USERKEY') }));
const ordLock = jest.fn((..._args: unknown[]) => ({ toHex: () => 'LOCKHEX' }));
jest.mock('@shared/ordinalP2PKH', () => ({ OrdinalsP2PKH: class { lock(...args: unknown[]) { return ordLock(...args); } } }));
jest.mock('@bsv/wallet-helper', () => ({ WalletP2PKH: class { unlock() { return { estimateLength: async () => 100 }; } } }));
jest.mock('@bsv/sdk', () => ({
  Transaction: {
    fromBEEF: jest.fn(),
    // The route derives the txid locally via .id('hex') — same value broadcastTX
    // would have reported, since broadcastTX itself is just tx.id('hex').
    fromAtomicBEEF: jest.fn(() => ({ id: () => 'MINTTX' })),
  },
}));

import request from 'supertest';
import { ObjectId } from 'mongodb';
import { buildApp } from '@server/app';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';

const stubWallet = {
  createAction: jest.fn(async () => ({ signableTransaction: { reference: 'REF', tx: [7, 7] } })),
  signAction: jest.fn(async () => ({ tx: Uint8Array.from([9, 9]) })),
};

const ID_A = '507f1f77bcf86cd799439011';
const ID_B = '507f1f77bcf86cd799439012';

// quantity and cosmetic metadata are FORGED: the server must mint 2 (one per owned
// inventory unit) with loot-table metadata.
const validBody = {
  materials: [
    {
      lootTableId: 'phoenix_feather',
      itemName: 'Forged Feather',
      description: 'forged',
      icon: 'x',
      rarity: 'common',
      tier: 1,
      quantity: 1_000_000,
      inventoryItemIds: [ID_A, ID_B],
      acquiredFrom: ['sand_djinn'],
    },
  ],
  userIdentityKey: 'USER_ID_KEY',
  paymentTx: 'PAYMENT_B64',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
};

const withMaterial = (overrides: Record<string, unknown>) => ({
  ...validBody,
  materials: [{ ...validBody.materials[0], ...overrides }],
});

function seedTxMocks() {
  // 1st fromBEEF = payment tx; 2nd = signable mint tx
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis: 100 }] })
    .mockReturnValueOnce({ inputs: [{ unlockingScript: { toHex: () => 'UNLOCKHEX' } }], sign: async () => {} });
}

/** The claim id the route stamped on the inventory units (first updateMany call). */
const claimId = () => updateMany.mock.calls[0][1].$set.mintClaim as string;

describe('POST /api/materials/mint-and-transfer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Transaction as any).fromBEEF = jest.fn();
    insertOne.mockResolvedValue({ insertedId: 'MATERIAL_TOKEN_OID' });
    updateMany.mockResolvedValue({ modifiedCount: 2 });
    deleteMany.mockResolvedValue({ deletedCount: 2 });
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
  });

  it('400 on empty materials array', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send({
      ...validBody,
      materials: [],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid materials data' });
  });

  it('400 on missing materials', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send({
      userIdentityKey: 'USER_ID_KEY',
      paymentTx: 'PAYMENT_B64',
      walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid materials data' });
  });

  it('400 when materials length !== 1', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send({
      ...validBody,
      materials: [validBody.materials[0], validBody.materials[0]],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Only one material token can be minted per request' });
  });

  it('400 when missing userIdentityKey', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send({
      ...validBody,
      userIdentityKey: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing user identity key' });
  });

  it('400 when missing paymentTx', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send({
      ...validBody,
      paymentTx: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing payment transaction' });
  });

  it('400 when walletParams incomplete', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send({
      ...validBody,
      walletParams: { protocolID: [0, 'x'] }, // missing keyID and counterparty
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing wallet derivation parameters' });
  });

  it('400 when lootTableId is not a material', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(withMaterial({ lootTableId: 'excalibur' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Not a material: excalibur' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when tier is not an integer 1-5', async () => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(withMaterial({ tier: { $ne: null } }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid tier' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['duplicated', [ID_A, ID_A]],
    ['malformed', ['not-an-object-id']],
  ])('400 when inventoryItemIds are %s', async (_label, ids) => {
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(withMaterial({ inventoryItemIds: ids }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid inventoryItemIds' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when payment satoshis < 100', async () => {
    (Transaction.fromBEEF as jest.Mock).mockReturnValueOnce({
      id: () => 'PAYTXID',
      outputs: [{ satoshis: 50 }],
    });
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid payment: must be at least 100 satoshis' });
  });

  it('409 when material token already exists (no units claimed)', async () => {
    seedTxMocks();
    findOne.mockResolvedValueOnce({ tokenId: 'existing-token', quantity: 10 });
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('shouldUseAddAndMerge', true);
    expect(res.body).toHaveProperty('existingTokenId', 'existing-token');
    expect(updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409 and releases the claim when not every inventory unit could be claimed', async () => {
    seedTxMocks();
    findOne.mockResolvedValueOnce(null);
    updateMany.mockResolvedValueOnce({ modifiedCount: 1 }); // one unit missing or claimed by a concurrent mint

    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Inventory items missing or already being minted' });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenLastCalledWith({ mintClaim: claimId() }, { $unset: { mintClaim: '' } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('mints exactly the claimed unit count with loot-table metadata, consumes the units, returns the success shape', async () => {
    seedTxMocks();
    findOne.mockResolvedValueOnce(null); // no existing token

    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      dbRecorded: true,
      results: [
        {
          lootTableId: 'phoenix_feather',
          tokenId: 'MINTTX.0',
          mintOutpoint: 'MINTTX.0',
          quantity: 2,
          materialTokenId: 'MATERIAL_TOKEN_OID',
          updated: false,
        },
      ],
      transferBeef: 'BEEF_B64',
      received: { outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVER_ID', tags: ['type:material'] },
    });

    // Claim: only this user's unclaimed units of this material + tier.
    expect(updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: [new ObjectId(ID_A), new ObjectId(ID_B)] },
        userId: 'u1',
        lootTableId: 'phoenix_feather',
        tier: 1,
        nftLootId: { $exists: false },
        tokenId: { $exists: false },
        mintClaim: { $exists: false },
      },
      { $set: { mintClaim: expect.any(String) } },
    );

    // Inscribed amount = claimed unit count; metadata from the loot table.
    expect(ordLock).toHaveBeenCalledWith(
      'USERKEY',
      '',
      expect.objectContaining({ itemName: 'Phoenix Feather', description: 'Grants resurrection', icon: '🪶', rarity: 'legendary', tier: 1 }),
      'deploy+mint',
      2,
    );

    // Wallet work ran through the serialized queue under the 'mint:material' label.
    expect(enqueue).toHaveBeenCalledWith('mint:material', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(1);
    expect(stubWallet.signAction).toHaveBeenCalledTimes(1);

    // DB writes happened AFTER the enqueue resolved; the claimed units were consumed.
    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2, itemName: 'Phoenix Feather' }));
    expect(deleteMany).toHaveBeenCalledWith({ mintClaim: claimId() });
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(insertOne.mock.invocationCallOrder[0]);

    // Overlay push is fire-and-forget AFTER the response — flush pending microtasks
    // so the off-path broadcast (fired synchronously right after res.json) has run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(1);
  });

  it('500s and releases the claim when the wallet mint throws', async () => {
    seedTxMocks();
    findOne.mockResolvedValueOnce(null);
    enqueue.mockRejectedValueOnce(new Error('mint boom'));
    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(updateMany).toHaveBeenLastCalledWith({ mintClaim: claimId() }, { $unset: { mintClaim: '' } });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('still returns 200 with the mint result + dbRecorded:false when the DB write fails', async () => {
    seedTxMocks();
    findOne.mockResolvedValueOnce(null);
    insertOne.mockRejectedValueOnce(new Error('db down'));

    const res = await request(buildApp()).post('/api/materials/mint-and-transfer').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.dbRecorded).toBe(false);
    // The mint happened and the client can still internalize the token.
    expect(res.body.results[0].tokenId).toBe('MINTTX.0');
    expect(res.body.transferBeef).toBe('BEEF_B64');
    expect(res.body.received).toEqual({ outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVER_ID', tags: ['type:material'] });
    expect(res.body.results).toEqual([
      {
        lootTableId: 'phoenix_feather',
        tokenId: 'MINTTX.0',
        mintOutpoint: 'MINTTX.0',
        quantity: 2,
        materialTokenId: undefined,
        updated: false,
      },
    ]);
    // Units stay claimed (not released) so they can never be minted a second time.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('mint:material', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(1);
  });
});

// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'u1'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: jest.fn(async () => ({ enqueue })) }));

const findOne = jest.fn();
const insertOne = jest.fn(async () => ({ insertedId: 'NFT_OID' }));
const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    userInventoryCollection: { findOne, updateOne },
    nftLootCollection: { insertOne },
  })),
}));

jest.mock('@server/lib/serverWallet', () => ({ getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID') }));
jest.mock('@shared/overlayFunctions', () => ({ broadcastTX: jest.fn(async () => ({ txid: 'MINTTX' })) }));
jest.mock('@shared/beefEncoding', () => ({ decodeBeef: jest.fn(() => [1, 2, 3]), encodeBeef: jest.fn(() => 'BEEF_B64') }));
jest.mock('@shared/tokenDerivation', () => ({ generateNonce: jest.fn(() => 'NONCE'), deriveRecipientKey: jest.fn(async () => 'USERKEY') }));
jest.mock('@shared/ordinalP2PKH', () => ({ OrdinalsP2PKH: class { lock() { return { toHex: () => 'LOCKHEX' }; } } }));
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
import { buildApp } from '@server/app';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';

const stubWallet = {
  createAction: jest.fn(async () => ({ signableTransaction: { reference: 'REF', tx: [7, 7] } })),
  signAction: jest.fn(async () => ({ tx: Uint8Array.from([9, 9]) })),
};

const validBody = {
  inventoryItemId: '507f1f77bcf86cd799439011',
  itemData: { name: 'Sword', description: 'd', icon: 'i', rarity: 'rare' },
  userIdentityKey: 'USER_ID_KEY',
  paymentTx: 'PAYMENT_B64',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
};

function seedTxMocks() {
  // 1st fromBEEF = payment tx; 2nd = signable mint tx
  // Access Transaction.fromBEEF directly instead of module-level fromBEEF variable,
  // so that reassigning Transaction.fromBEEF in beforeEach will properly reset the queue
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis: 100 }] })
    .mockReturnValueOnce({ inputs: [{ unlockingScript: { toHex: () => 'UNLOCKHEX' } }], sign: async () => {} });
}

describe('POST /api/items/mint-and-transfer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset Transaction.fromBEEF to a fresh jest.fn() to clear any mockReturnValueOnce queue
    // from previous tests (seedTxMocks now uses Transaction.fromBEEF directly, so this works)
    (Transaction as any).fromBEEF = jest.fn();
    // Re-apply default implementations
    insertOne.mockResolvedValue({ insertedId: 'NFT_OID' });
    updateOne.mockResolvedValue({ matchedCount: 1 });
    // Restore enqueue's special implementation
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
  });

  it('400 on missing required fields', async () => {
    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('404 when the item is not owned by the user', async () => {
    findOne.mockResolvedValueOnce(null);
    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send(validBody);
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the item is a material (materials mint as material tokens, never as NFTs)', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'common_wood', itemType: 'material' });
    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Materials are minted as material tokens' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the loot table says material even though the doc has no itemType', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'common_wood' });
    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Materials are minted as material tokens' });
  });

  it('400 when the item is already minted', async () => {
    findOne.mockResolvedValueOnce({ nftLootId: 'already' });
    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Item already minted' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('mints via the wallet queue, writes DB after, returns the success shape', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' });
    seedTxMocks();

    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      dbRecorded: true,
      nftId: 'NFT_OID',
      tokenId: 'MINTTX.0',
      mintOutpoint: 'MINTTX.0',
      transferBeef: 'BEEF_B64',
      received: { outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVER_ID', tags: ['type:item'] },
    });

    // Wallet work ran through the serialized queue under the 'mint:item' label.
    expect(enqueue).toHaveBeenCalledWith('mint:item', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(1);
    expect(stubWallet.signAction).toHaveBeenCalledTimes(1);

    // DB writes happened AFTER the enqueue resolved.
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(insertOne.mock.invocationCallOrder[0]);

    // Overlay push is fire-and-forget AFTER the response — flush pending microtasks
    // so the off-path broadcast (fired synchronously right after res.json) has run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(1);
  });

  it('500s via the error handler when the wallet mint throws (async error propagates through buildApp)', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' });
    seedTxMocks();
    enqueue.mockRejectedValueOnce(new Error('mint boom'));
    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send(validBody);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('still returns 200 with the mint result + dbRecorded:false when the DB write fails', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' });
    seedTxMocks();
    insertOne.mockRejectedValueOnce(new Error('db down'));

    const res = await request(buildApp()).post('/api/items/mint-and-transfer').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.dbRecorded).toBe(false);
    // The mint happened and the client can still internalize the token.
    expect(res.body.tokenId).toBe('MINTTX.0');
    expect(res.body.transferBeef).toBe('BEEF_B64');
    expect(res.body.received).toEqual({ outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVER_ID', tags: ['type:item'] });
    expect(res.body.nftId).toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith('mint:item', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(1);
  });
});

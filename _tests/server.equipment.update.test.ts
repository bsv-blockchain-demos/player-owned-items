// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'u1'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: jest.fn(async () => ({ enqueue })) }));

const equipmentFindOne = jest.fn();
let scrollsToArray: any[] = [];
const inventoryInsertOne = jest.fn(async () => ({ insertedId: 'INV_OID' }));
const inventoryDeleteOne = jest.fn(async () => ({ deletedCount: 1 }));
const nftFindOne = jest.fn(async () => ({ mintOutpoint: 'ORIGMINT.0' }));
const nftInsertOne = jest.fn(async () => ({ insertedId: 'NFT_OID' }));
const playerStatsFindOne = jest.fn(async () => null);
const playerStatsUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));

jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    userInventoryCollection: {
      findOne: equipmentFindOne,
      find: jest.fn(() => ({ toArray: async () => scrollsToArray })),
      insertOne: inventoryInsertOne,
      deleteOne: inventoryDeleteOne,
    },
    nftLootCollection: { findOne: nftFindOne, insertOne: nftInsertOne },
    playerStatsCollection: { findOne: playerStatsFindOne, updateOne: playerStatsUpdateOne },
  })),
}));

// Pre-lock reads use the SAME singleton wallet the queue serializes over — mock
// getServerWallet() to resolve to the exact stubWallet passed into enqueue.
jest.mock('@server/lib/serverWallet', () => ({
  getServerWallet: jest.fn(async () => stubWallet),
  getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID'),
}));

// broadcastTX is now fire-and-forget off-path (txid is derived locally, not from
// its return value) — default to a resolving promise so `.catch()` on the call site
// never throws synchronously on an undefined return.
jest.mock('@shared/overlayFunctions', () => ({ broadcastTX: jest.fn(async () => ({ txid: 'OVERLAY_TXID' })) }));
jest.mock('@shared/beefEncoding', () => ({ decodeBeef: jest.fn(() => [1, 2, 3]), encodeBeef: jest.fn(() => 'BEEF_B64') }));

let nonceQueue: string[] = [];
jest.mock('@shared/tokenDerivation', () => ({
  TOKEN_PROTOCOL: [2, 'monsterbattle token'],
  generateNonce: jest.fn(() => nonceQueue.shift() ?? 'NONCE_FALLBACK'),
  deriveRecipientKey: jest.fn(async () => 'USERKEY'),
}));
jest.mock('@shared/ordinalP2PKH', () => ({
  OrdinalsP2PKH: class {
    lock() { return { toHex: () => 'LOCKHEX' }; }
    unlock() { return { estimateLength: async () => 100 }; }
  },
}));
jest.mock('@bsv/wallet-helper', () => ({ WalletP2PKH: class { unlock() { return { estimateLength: async () => 100 }; } } }));
jest.mock('@bsv/sdk', () => ({
  Transaction: {
    fromBEEF: jest.fn(),
    fromAtomicBEEF: jest.fn(() => ({})),
  },
  Beef: class { mergeBeef() {} toBinary() { return []; } toBEEF() { return []; } },
}));

import request from 'supertest';
import { buildApp } from '@server/app';
import { ObjectId } from 'mongodb';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';

const stubWallet = {
  createAction: jest.fn(),
  signAction: jest.fn(),
};

const validBody = {
  originalEquipmentInventoryId: '507f1f77bcf86cd799439011',
  originalEquipmentTokenId: 'ORIGTX.0',
  inscriptionScrollInventoryIds: ['507f1f77bcf86cd799439012', '507f1f77bcf86cd799439013'],
  transferredEquipmentTokenId: 'BATCHTX.0',
  transferredScrollTokenIds: ['BATCHTX.1', 'BATCHTX.2'],
  batchTransferBeef: 'BATCH_B64',
  transferNonce: 'N2',
  userIdentityKey: 'USER_ID_KEY',
  equipmentData: {
    lootTableId: 'iron_sword',
    name: 'Iron Sword',
    description: 'A sturdy sword',
    icon: '⚔️',
    rarity: 'rare',
    type: 'weapon',
    tier: 1,
    equipmentStats: { damageBonus: 10 },
    crafted: null,
    borderGradient: { color1: 'a', color2: 'b' },
  },
  updatedPrefix: 'Sharp',
  updatedSuffix: null,
  paymentTx: 'PAYMENT_B64',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
};

/** payment tx + batch-transfer tx — reached by every request past validation/ownership gates. */
function seedPaymentAndBatchMocks() {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis: 100 }], toBEEF: () => [3, 3] })
    .mockReturnValueOnce({ toBEEF: () => [1, 1] });
}

/** The single wallet action inside the queue (update equipment, 4 inputs: equipment + 2 scrolls + payment). */
function seedEnqueueMocks() {
  (Transaction.fromBEEF as jest.Mock).mockReturnValueOnce({
    inputs: [
      { unlockingScript: { toHex: () => 'U0' } },
      { unlockingScript: { toHex: () => 'U1' } },
      { unlockingScript: { toHex: () => 'U2' } },
      { unlockingScript: { toHex: () => 'U3' } },
    ],
    sign: async () => {},
  });

  // The txid is now derived locally via .id('hex') on the fromAtomicBEEF result —
  // same value broadcastTX would have reported (it's just tx.id('hex')). The
  // mockReturnValue (not Once) covers both the call inside enqueue AND the
  // off-path re-decode fired after the response.
  (Transaction.fromAtomicBEEF as jest.Mock).mockReturnValue({ id: () => 'UPDATETX' });

  stubWallet.createAction.mockResolvedValueOnce({ signableTransaction: { reference: 'REF1', tx: [7, 7] } });
  stubWallet.signAction.mockResolvedValueOnce({ tx: Uint8Array.from([9, 9]) });

  nonceQueue = ['N3_NONCE'];
}

describe('POST /api/equipment/update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Transaction as any).fromBEEF = jest.fn();
    (Transaction as any).fromAtomicBEEF = jest.fn(() => ({}));
    equipmentFindOne.mockReset();
    scrollsToArray = [{ _id: '507f1f77bcf86cd799439012' }, { _id: '507f1f77bcf86cd799439013' }];
    inventoryInsertOne.mockResolvedValue({ insertedId: 'INV_OID' });
    inventoryDeleteOne.mockResolvedValue({ deletedCount: 1 });
    nftFindOne.mockResolvedValue({ mintOutpoint: 'ORIGMINT.0' });
    nftInsertOne.mockResolvedValue({ insertedId: 'NFT_OID' });
    playerStatsFindOne.mockResolvedValue(null);
    playerStatsUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
    nonceQueue = [];
  });

  it('400 on missing required fields', async () => {
    const res = await request(buildApp()).post('/api/equipment/update').send({
      ...validBody,
      originalEquipmentInventoryId: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(equipmentFindOne).not.toHaveBeenCalled();
  });

  it('400 on zero inscription scrolls', async () => {
    const res = await request(buildApp()).post('/api/equipment/update').send({
      ...validBody,
      inscriptionScrollInventoryIds: [],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'At least one inscription scroll required' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on more than 2 inscription scrolls', async () => {
    const res = await request(buildApp()).post('/api/equipment/update').send({
      ...validBody,
      inscriptionScrollInventoryIds: ['a', 'b', 'c'],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Maximum 2 inscription scrolls allowed (prefix + suffix)' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on missing paymentTx', async () => {
    const res = await request(buildApp()).post('/api/equipment/update').send({
      ...validBody,
      paymentTx: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing payment transaction' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on missing walletParams', async () => {
    const res = await request(buildApp()).post('/api/equipment/update').send({
      ...validBody,
      walletParams: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing wallet derivation parameters' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404 when original equipment is not owned by user (rejects before enqueue)', async () => {
    equipmentFindOne.mockResolvedValueOnce(null);

    const res = await request(buildApp()).post('/api/equipment/update').send(validBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Original equipment not found or not owned by user' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404 when scroll count does not match owned scrolls (rejects before enqueue)', async () => {
    equipmentFindOne.mockResolvedValueOnce({ _id: 'EQUIP_OID', nftLootId: 'NFT_ORIG' });
    scrollsToArray = [{ _id: '507f1f77bcf86cd799439012' }]; // only 1 of 2 requested found

    const res = await request(buildApp()).post('/api/equipment/update').send(validBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'One or more inscription scrolls not found or not owned by user' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('updates equipment via the wallet queue, writes DB after, returns the success shape', async () => {
    equipmentFindOne.mockResolvedValueOnce({ _id: 'EQUIP_OID', nftLootId: 'NFT_ORIG', tier: 1, borderGradient: { color1: 'x', color2: 'y' } });
    seedPaymentAndBatchMocks();
    seedEnqueueMocks();

    const res = await request(buildApp()).post('/api/equipment/update').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      nftId: 'NFT_OID',
      tokenId: 'UPDATETX.0',
      transactionId: 'UPDATETX',
      newInventoryItemId: 'INV_OID',
      wasEquipped: false,
      transferBeef: 'BEEF_B64',
      received: { outputIndex: 0, keyId: 'N3_NONCE', counterparty: 'SERVER_ID', tags: ['type:equipment'] },
    });

    // The wallet action ran through the serialized queue under the expected label.
    expect(enqueue).toHaveBeenCalledWith('update:equipment', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(1);
    expect(stubWallet.signAction).toHaveBeenCalledTimes(1);

    // DB writes happened AFTER the enqueue resolved.
    expect(nftInsertOne).toHaveBeenCalledTimes(1);
    expect(nftInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        lootTableId: 'iron_sword',
        mintOutpoint: 'ORIGMINT.0',
        tokenId: 'UPDATETX.0',
        keyId: 'N3_NONCE',
        counterparty: 'SERVER_ID',
        userId: 'u1',
      }),
    );
    expect(inventoryInsertOne).toHaveBeenCalledTimes(1);
    expect(inventoryInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        lootTableId: 'iron_sword',
        tokenId: 'UPDATETX.0',
        transactionId: 'UPDATETX',
        prefix: 'Sharp',
        suffix: null,
      }),
    );
    // Original equipment + both consumed scrolls deleted.
    expect(inventoryDeleteOne).toHaveBeenCalledTimes(3);

    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(nftInsertOne.mock.invocationCallOrder[0]);
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(inventoryInsertOne.mock.invocationCallOrder[0]);

    // Overlay push is fire-and-forget AFTER the response — flush pending microtasks
    // so the off-path broadcast (fired synchronously right after res.json) has run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(1);
  });

  it('500s via the error handler when the wallet queue throws', async () => {
    equipmentFindOne.mockResolvedValueOnce({ _id: 'EQUIP_OID', nftLootId: 'NFT_ORIG' });
    seedPaymentAndBatchMocks();
    enqueue.mockRejectedValueOnce(new Error('update boom'));

    const res = await request(buildApp()).post('/api/equipment/update').send(validBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(nftInsertOne).not.toHaveBeenCalled();
    expect(inventoryInsertOne).not.toHaveBeenCalled();
  });

  it('moves the equipped slot to the re-minted item', async () => {
    const original = new ObjectId(validBody.originalEquipmentInventoryId);
    const reminted = new ObjectId();
    equipmentFindOne.mockResolvedValueOnce({ _id: original, nftLootId: 'NFT_ORIG', tier: 1 });
    inventoryInsertOne.mockResolvedValueOnce({ insertedId: reminted } as any);
    playerStatsFindOne.mockResolvedValueOnce({ userId: 'u1', equippedItems: { armor: new ObjectId(), weapon: original } } as any);
    seedPaymentAndBatchMocks();
    seedEnqueueMocks();

    const res = await request(buildApp()).post('/api/equipment/update').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.wasEquipped).toBe(true);
    expect(playerStatsUpdateOne).toHaveBeenCalledWith({ userId: 'u1' }, { $set: { 'equippedItems.weapon': reminted } });
  });
});

// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'u1'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
const getWalletQueue = jest.fn(async () => ({ enqueue }));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: () => getWalletQueue() }));

// Owned minted inventory docs keyed by id; the route must read identity from these, not the body.
let ownedDocs: Record<string, any> = {};
const inventoryFindOne = jest.fn(async (q: any) => {
  const d = ownedDocs[q._id.toHexString()];
  return d && q.userId === 'u1' ? { _id: q._id, ...d } : null;
});
const inventoryInsertOne = jest.fn(async (_doc: any): Promise<{ insertedId: unknown }> => ({ insertedId: 'INV_OID' }));
const inventoryDeleteOne = jest.fn(async (_filter: any) => ({ deletedCount: 1 }));
const inventoryUpdateMany = jest.fn(async (filter: any, _update: any) => ({ modifiedCount: filter.$or?.length ?? 0 }));
const nftFindOne = jest.fn(async () => ({ mintOutpoint: 'ORIGMINT.0' }));
const nftInsertOne = jest.fn(async (_doc: any) => ({ insertedId: 'NFT_OID' }));
const playerStatsFindOne = jest.fn(async (): Promise<unknown> => null);
const playerStatsUpdateOne = jest.fn(async (_f: any, _u: any) => ({ modifiedCount: 1 }));
const listingFindOne = jest.fn(async (_filter: any): Promise<unknown> => null);

jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    userInventoryCollection: {
      findOne: inventoryFindOne,
      insertOne: inventoryInsertOne,
      deleteOne: inventoryDeleteOne,
      updateMany: inventoryUpdateMany,
    },
    nftLootCollection: { findOne: nftFindOne, insertOne: nftInsertOne },
    playerStatsCollection: { findOne: playerStatsFindOne, updateOne: playerStatsUpdateOne },
    marketplaceItemsCollection: { findOne: listingFindOne },
  })),
}));

// Pre-lock reads use the SAME singleton wallet the queue serializes over.
jest.mock('@server/lib/serverWallet', () => ({
  getServerWallet: jest.fn(async () => stubWallet),
  getServerPublicKey: jest.fn(async () => 'LEGACY_PK'),
  getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID'),
}));

jest.mock('@shared/overlayFunctions', () => ({ broadcastTX: jest.fn(async () => ({ txid: 'OVERLAY_TXID' })) }));
jest.mock('@shared/beefEncoding', () => ({ decodeBeef: jest.fn(() => [1, 2, 3]), encodeBeef: jest.fn(() => 'BEEF_B64') }));

let nonceQueue: string[] = [];
jest.mock('@shared/tokenDerivation', () => ({
  TOKEN_PROTOCOL: [2, 'monsterbattle token'],
  generateNonce: jest.fn(() => nonceQueue.shift() ?? 'NONCE_FALLBACK'),
  deriveRecipientKey: jest.fn(async () => 'USERKEY'),
}));
const ordLock = jest.fn((..._args: unknown[]) => ({ toHex: () => 'LOCKHEX' }));
jest.mock('@shared/ordinalP2PKH', () => ({
  OrdinalsP2PKH: class {
    lock(...args: unknown[]) { return ordLock(...args); }
    unlock() { return { estimateLength: async () => 100 }; }
  },
}));
jest.mock('@bsv/wallet-helper', () => ({ WalletP2PKH: class { unlock() { return { estimateLength: async () => 100 }; } } }));
jest.mock('@bsv/sdk', () => ({
  Transaction: { fromBEEF: jest.fn(), fromAtomicBEEF: jest.fn(() => ({})) },
  Beef: class { mergeBeef() {} toBinary() { return []; } toBEEF() { return []; } },
  P2PKH: class { lock() { return { toHex: () => 'PS' }; } },
  Hash: { hash160: () => 'H' },
}));

import request from 'supertest';
import { inscribedScript } from './helpers/ordinalScript';
import { buildApp } from '@server/app';
import { ObjectId } from 'mongodb';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';

const stubWallet = {
  createAction: jest.fn(),
  signAction: jest.fn(),
  getPublicKey: jest.fn(async () => ({ publicKey: 'PK' })),
};

const EQUIP = '507f1f77bcf86cd799439011';
const SCROLL_P = '507f1f77bcf86cd799439012';
const SCROLL_S = '507f1f77bcf86cd799439013';
const gradient = { color1: 'g1', color2: 'g2' };

const defaultDocs = (): Record<string, any> => ({
  [EQUIP]: {
    userId: 'u1', lootTableId: 'common_dagger', itemType: 'weapon', tier: 2, nftLootId: new ObjectId(),
    tokenId: 'ORIGTX.0', mintOutpoint: 'ORIGMINT.0', borderGradient: gradient, crafted: true, statRoll: 1.1,
    rolledStats: { damageBonus: 1 }, isEmpowered: true,
  },
  [SCROLL_P]: { userId: 'u1', lootTableId: 'prefix_damage_common', itemType: 'inscription_scroll', tier: 1, nftLootId: new ObjectId(), tokenId: 'SCROLLPTX.0' },
  [SCROLL_S]: { userId: 'u1', lootTableId: 'suffix_damage_common', itemType: 'inscription_scroll', tier: 1, nftLootId: new ObjectId(), tokenId: 'SCROLLSTX.0' },
});

// equipmentData / updatedPrefix / updatedSuffix are FORGED to prove the server ignores them.
const validBody = {
  originalEquipmentInventoryId: EQUIP,
  inscriptionScrollInventoryIds: [SCROLL_P, SCROLL_S],
  transferredEquipmentTokenId: 'BATCHTX.0',
  transferredScrollTokenIds: ['BATCHTX.1', 'BATCHTX.2'],
  batchTransferBeef: 'BATCH_B64',
  transferNonce: 'N2',
  userIdentityKey: 'USER_ID_KEY',
  equipmentData: { lootTableId: 'soul_stone', name: 'Soul Stone', type: 'artifact', tier: 5, equipmentStats: { damageBonus: 999 } },
  updatedPrefix: { type: 'damage', value: 999, name: 'Forged' },
  updatedSuffix: { type: 'autoclick', value: 99, name: 'of Forgery' },
  paymentTx: 'PAYMENT_B64',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
};

const inscribed = (hex: string, amt: number, lootTableId: string) => inscribedScript(hex, amt, { lootTableId });
const defaultInputs = [
  { sourceTXID: 'ORIGTX', sourceOutputIndex: 0 },
  { sourceTXID: 'SCROLLPTX', sourceOutputIndex: 0 },
  { sourceTXID: 'SCROLLSTX', sourceOutputIndex: 0 },
];

/** payment tx + batch-transfer tx — reached by every request past the DB checks. */
function seedPaymentAndBatchMocks(
  scripts = ['LOCK_PS_0', 'LOCK_PS_1', 'LOCK_PS_2'],
  inputs = defaultInputs,
  amts = [1, 1, 1],
  lootIds = ['common_dagger', 'prefix_damage_common', 'suffix_damage_common'],
) {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis: 100 }], toBEEF: () => [3, 3] })
    .mockReturnValueOnce({
      id: () => 'BATCHTX',
      inputs,
      outputs: scripts.map((hex, i) => ({ lockingScript: inscribed(hex, amts[i], lootIds[i]) })),
      toBEEF: () => [1, 1],
    });
}

/** The single wallet action inside the queue (equipment + 2 scrolls + payment). */
function seedEnqueueMocks() {
  (Transaction.fromBEEF as jest.Mock).mockReturnValueOnce({
    inputs: [0, 1, 2, 3].map((i) => ({ unlockingScript: { toHex: () => `U${i}` } })),
    sign: async () => {},
  });
  (Transaction.fromAtomicBEEF as jest.Mock).mockReturnValue({ id: () => 'UPDATETX' });
  stubWallet.createAction.mockResolvedValueOnce({ signableTransaction: { reference: 'REF1', tx: [7, 7] } });
  stubWallet.signAction.mockResolvedValueOnce({ tx: Uint8Array.from([9, 9]) });
  nonceQueue = ['N3_NONCE'];
}

const claimId = () => inventoryUpdateMany.mock.calls[0][1].$set.pendingClaim as string;
const post = (body: unknown) => request(buildApp()).post('/api/equipment/update').send(body as object);
function expectNotClaimed() {
  expect(inventoryUpdateMany).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
}

describe('POST /api/equipment/update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Transaction as any).fromBEEF = jest.fn();
    (Transaction as any).fromAtomicBEEF = jest.fn(() => ({}));
    ownedDocs = defaultDocs();
    inventoryInsertOne.mockResolvedValue({ insertedId: 'INV_OID' });
    inventoryDeleteOne.mockResolvedValue({ deletedCount: 1 });
    inventoryUpdateMany.mockImplementation(async (filter: any) => ({ modifiedCount: filter.$or?.length ?? 0 }));
    nftFindOne.mockResolvedValue({ mintOutpoint: 'ORIGMINT.0' });
    nftInsertOne.mockResolvedValue({ insertedId: 'NFT_OID' });
    playerStatsFindOne.mockResolvedValue(null);
    playerStatsUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    listingFindOne.mockResolvedValue(null);
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
    getWalletQueue.mockImplementation(async () => ({ enqueue }));
    stubWallet.getPublicKey.mockResolvedValue({ publicKey: 'PK' });
    nonceQueue = [];
  });

  it('400 on missing required fields', async () => {
    const res = await post({ ...validBody, originalEquipmentInventoryId: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
    expect(inventoryFindOne).not.toHaveBeenCalled();
    expectNotClaimed();
  });

  it('400 on zero inscription scrolls', async () => {
    const res = await post({ ...validBody, inscriptionScrollInventoryIds: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'At least one inscription scroll required' });
  });

  it('400 on more than 2 inscription scrolls', async () => {
    const res = await post({ ...validBody, inscriptionScrollInventoryIds: ['a', 'b', 'c'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Maximum 2 inscription scrolls allowed (prefix + suffix)' });
  });

  it('400 on missing paymentTx', async () => {
    const res = await post({ ...validBody, paymentTx: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing payment transaction' });
  });

  it('400 on missing walletParams', async () => {
    const res = await post({ ...validBody, walletParams: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing wallet derivation parameters' });
  });

  it.each([
    ['a malformed scroll id', { inscriptionScrollInventoryIds: [SCROLL_P, { $ne: null }] }],
    ['the equipment id reused as a scroll', { inscriptionScrollInventoryIds: [EQUIP], transferredScrollTokenIds: ['BATCHTX.1'] }],
    ['fewer transfer outpoints than scrolls', { transferredScrollTokenIds: ['BATCHTX.1'] }],
    ['a non-string transfer outpoint', { transferredEquipmentTokenId: 7 }],
  ])('400 on %s', async (_label, patch) => {
    const res = await post({ ...validBody, ...patch });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid equipment or scroll ids' });
    expectNotClaimed();
  });

  it('404 when the equipment is not an owned minted item', async () => {
    delete ownedDocs[EQUIP];
    const res = await post(validBody);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Original equipment not found or not owned by user' });
    expect(inventoryFindOne).toHaveBeenCalledWith({
      _id: new ObjectId(EQUIP), userId: 'u1', nftLootId: { $type: 'objectId' }, tokenId: { $type: 'string' },
    });
    expectNotClaimed();
  });

  it('400 when the "equipment" is not inscribable (loot table decides, not the body)', async () => {
    ownedDocs[EQUIP].lootTableId = 'common_wood';
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Only weapons, armor, and artifacts can be inscribed' });
    expectNotClaimed();
  });

  it('404 when a scroll is not an owned minted item', async () => {
    delete ownedDocs[SCROLL_S];
    const res = await post(validBody);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'One or more inscription scrolls not found or not owned by user' });
    expectNotClaimed();
  });

  it('400 when a "scroll" is not an inscription scroll', async () => {
    ownedDocs[SCROLL_S].lootTableId = 'spirit_crystal';
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Selected item is not an inscription scroll' });
    expectNotClaimed();
  });

  it('400 when two scrolls target the same slot', async () => {
    ownedDocs[SCROLL_S].lootTableId = 'prefix_damage_common';
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'One inscription scroll per slot' });
    expectNotClaimed();
  });

  it.each([
    ['autoclick', 'suffix_autoclick_legendary_2'],
    ['lifesteal', 'suffix_lifesteal_legendary'],
  ])('400 when the result would carry a %s prefix and suffix', async (type, suffixScroll) => {
    ownedDocs[EQUIP].prefix = { type, value: 1, name: 'Existing' };
    ownedDocs[SCROLL_S].lootTableId = suffixScroll;
    const res = await post({ ...validBody, inscriptionScrollInventoryIds: [SCROLL_S], transferredScrollTokenIds: ['BATCHTX.1'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Cannot have both ${type} prefix and suffix on the same item` });
    expectNotClaimed();
  });

  it('409 when the equipment or a scroll is listed on the marketplace', async () => {
    listingFindOne.mockResolvedValueOnce({ _id: 'LISTING', inventoryItemId: SCROLL_P, status: 'pending' });
    const res = await post(validBody);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Item is listed on the marketplace' });
    expect(listingFindOne).toHaveBeenCalledWith({ inventoryItemId: { $in: [EQUIP, SCROLL_P, SCROLL_S] }, status: { $in: ['active', 'pending'] } });
    expectNotClaimed();
  });

  it('400 when the batch does not spend the owned equipment (another token passed off as it)', async () => {
    seedPaymentAndBatchMocks(undefined, [{ sourceTXID: 'SOMEOTHERTX', sourceOutputIndex: 0 }, ...defaultInputs.slice(1)]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Equipment common_dagger transfer does not spend owned token' });
    expectNotClaimed();
  });

  it('400 when a transferred output is not locked to the server derived key', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_0', 'SOMEONE_ELSE', 'LOCK_PS_2']);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Scroll prefix_damage_common not locked to server derived key' });
    expectNotClaimed();
  });

  it('400 when a transfer does not carry amount 1', async () => {
    seedPaymentAndBatchMocks(undefined, undefined, [1, 1, 2]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Scroll suffix_damage_common transfer must carry amount 1' });
    expectNotClaimed();
  });

  it('400 when a scroll transfer is inscribed as another scroll', async () => {
    seedPaymentAndBatchMocks(undefined, undefined, undefined, ['common_dagger', 'prefix_damage_common', 'suffix_autoclick_legendary_2']);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Scroll suffix_damage_common transfer is inscribed as suffix_autoclick_legendary_2' });
    expectNotClaimed();
  });

  it('400 when two entries name the same transfer outpoint', async () => {
    seedPaymentAndBatchMocks();
    const res = await post({ ...validBody, transferredScrollTokenIds: ['BATCHTX.1', 'BATCHTX.1'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transfer outpoint used twice: BATCHTX.1' });
    expectNotClaimed();
  });

  it('400 when a transfer outpoint names another transaction', async () => {
    seedPaymentAndBatchMocks();
    const res = await post({ ...validBody, transferredEquipmentTokenId: 'OTHERTX.0' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transfer outpoint not in batch transfer: OTHERTX.0' });
    expectNotClaimed();
  });

  it('409 and releases the claim when an item is already claimed', async () => {
    seedPaymentAndBatchMocks();
    inventoryUpdateMany.mockResolvedValueOnce({ modifiedCount: 2 });
    const res = await post(validBody);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material tokens are already in use' });
    expect(inventoryUpdateMany).toHaveBeenCalledWith(
      {
        userId: 'u1',
        pendingClaim: { $exists: false },
        $or: [
          { _id: new ObjectId(EQUIP), tokenId: 'ORIGTX.0' },
          { _id: new ObjectId(SCROLL_P), tokenId: 'SCROLLPTX.0' },
          { _id: new ObjectId(SCROLL_S), tokenId: 'SCROLLSTX.0' },
        ],
      },
      { $set: { pendingClaim: expect.any(String) } },
    );
    expect(inventoryUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: claimId() }, { $unset: { pendingClaim: '' } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('derives the updated item from the owned docs + loot table (ignoring forged body fields)', async () => {
    seedPaymentAndBatchMocks();
    seedEnqueueMocks();

    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      dbRecorded: true,
      nftId: 'NFT_OID',
      tokenId: 'UPDATETX.0',
      transactionId: 'UPDATETX',
      newInventoryItemId: 'INV_OID',
      wasEquipped: false,
      transferBeef: 'BEEF_B64',
      received: { outputIndex: 0, keyId: 'N3_NONCE', counterparty: 'SERVER_ID', tags: ['type:equipment'] },
    });

    const prefix = { type: 'damage', value: 3, name: 'Savage' };
    const suffix = { type: 'damage', value: 3, name: 'of Fury' };
    expect(ordLock).toHaveBeenCalledWith('USERKEY', 'ORIGTX_0', {
      name: 'game_item',
      itemName: 'Rusty Dagger',
      description: 'A worn but functional blade',
      icon: '🗡️',
      rarity: 'common',
      itemType: 'weapon',
      tier: 2,
      stats: expect.objectContaining({ damageBonus: 1 }),
      crafted: { statRoll: 1.1 },
      enhancements: { prefix, suffix },
      visual: { borderGradient: gradient },
    }, 'transfer');

    // The wallet spends exactly the validated batch outpoints, then the payment.
    const inputs = stubWallet.createAction.mock.calls[0][0].inputs.map((i: { outpoint: string }) => i.outpoint);
    expect(inputs).toEqual(['BATCHTX.0', 'BATCHTX.1', 'BATCHTX.2', 'PAYTXID.0']);
    expect(inventoryUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);

    expect(nftInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      lootTableId: 'common_dagger', type: 'weapon', mintOutpoint: 'ORIGMINT.0', tokenId: 'UPDATETX.0', keyId: 'N3_NONCE', userId: 'u1',
    }));
    expect(inventoryInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      lootTableId: 'common_dagger',
      itemType: 'weapon',
      tier: 2,
      tokenId: 'UPDATETX.0',
      prefix,
      suffix,
      crafted: true,
      statRoll: 1.1,
      rolledStats: { damageBonus: 1 },
      isEmpowered: true,
      borderGradient: gradient,
    }));
    // Consumed docs are deleted only at the outpoints this request claimed.
    expect(inventoryDeleteOne).toHaveBeenCalledTimes(3);
    expect(inventoryDeleteOne).toHaveBeenCalledWith({ _id: new ObjectId(EQUIP), userId: 'u1', tokenId: 'ORIGTX.0', pendingClaim: claimId() });
    expect(inventoryDeleteOne).toHaveBeenCalledWith({ _id: new ObjectId(SCROLL_S), userId: 'u1', tokenId: 'SCROLLSTX.0', pendingClaim: claimId() });

    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing inscription in the slot no scroll targets', async () => {
    ownedDocs[EQUIP].suffix = { type: 'damage', value: 5, name: 'of Old' };
    seedPaymentAndBatchMocks(['LOCK_PS_0', 'LOCK_PS_1'], defaultInputs.slice(0, 2));
    seedEnqueueMocks();
    const res = await post({ ...validBody, inscriptionScrollInventoryIds: [SCROLL_P], transferredScrollTokenIds: ['BATCHTX.1'] });
    expect(res.status).toBe(200);
    expect(inventoryInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      prefix: { type: 'damage', value: 3, name: 'Savage' },
      suffix: { type: 'damage', value: 5, name: 'of Old' },
    }));
  });

  it('moves the equipped slot to the re-minted item', async () => {
    const reminted = new ObjectId();
    inventoryInsertOne.mockResolvedValueOnce({ insertedId: reminted });
    playerStatsFindOne.mockResolvedValueOnce({ userId: 'u1', equippedItems: { armor: new ObjectId(), weapon: new ObjectId(EQUIP) } });
    seedPaymentAndBatchMocks();
    seedEnqueueMocks();

    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(res.body.wasEquipped).toBe(true);
    expect(playerStatsUpdateOne).toHaveBeenCalledWith({ userId: 'u1' }, { $set: { 'equippedItems.weapon': reminted } });
  });

  it('claims nothing when the wallet queue cannot be obtained', async () => {
    seedPaymentAndBatchMocks();
    getWalletQueue.mockRejectedValueOnce(new Error('queue down'));
    const res = await post(validBody);
    expect(res.status).toBe(500);
    expectNotClaimed();
  });

  it('500s and releases the claim when the wallet queue throws', async () => {
    seedPaymentAndBatchMocks();
    enqueue.mockRejectedValueOnce(new Error('update boom'));
    const res = await post(validBody);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(inventoryUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: claimId() }, { $unset: { pendingClaim: '' } });
    expect(nftInsertOne).not.toHaveBeenCalled();
    expect(inventoryDeleteOne).not.toHaveBeenCalled();
  });

  it('still returns the BEEF when a DB write fails after the wallet succeeded, keeping the claim', async () => {
    seedPaymentAndBatchMocks();
    seedEnqueueMocks();
    nftInsertOne.mockRejectedValueOnce(new Error('db down'));
    const res = await post(validBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, dbRecorded: false, tokenId: 'UPDATETX.0', transferBeef: 'BEEF_B64' }));
    expect(inventoryUpdateMany).toHaveBeenCalledTimes(1); // claim held: the items are spent on chain
  });
});

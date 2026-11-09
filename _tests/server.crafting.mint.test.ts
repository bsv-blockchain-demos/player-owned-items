// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'u1'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: jest.fn(async () => ({ enqueue })) }));

const nftInsertOne = jest.fn(async () => ({ insertedId: 'NFT_OID' }));
const inventoryInsertOne = jest.fn(async () => ({ insertedId: 'INV_OID' }));
const materialDeleteOne = jest.fn(async () => ({ deletedCount: 1 }));
const materialUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
// Server-trusted material tokens keyed by lootTableId — the DB, not the body, owns quantity.
let ownedTokens: Record<string, { tokenId: string; quantity: number; tier: number }> = {};
const materialFindOne = jest.fn(async (q: { userId: string; lootTableId: string }) =>
  (q.userId === 'u1' ? ownedTokens[q.lootTableId] ?? null : null));
let playerLevel = 1;
const playerStatsFindOne = jest.fn(async () => ({ userId: 'u1', level: playerLevel }));
jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    userInventoryCollection: { insertOne: inventoryInsertOne },
    nftLootCollection: { insertOne: nftInsertOne },
    materialTokensCollection: { findOne: materialFindOne, deleteOne: materialDeleteOne, updateOne: materialUpdateOne },
    playerStatsCollection: { findOne: playerStatsFindOne },
  })),
}));

// Pre-lock reads use the SAME singleton wallet the queue serializes over — mock
// getServerWallet() to resolve to the exact stubWallet passed into enqueue.
jest.mock('@server/lib/serverWallet', () => ({
  getServerWallet: jest.fn(async () => stubWallet),
  getServerPublicKey: jest.fn(async () => 'LEGACY_PK'),
  getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID'),
}));

// broadcastTX is now fire-and-forget off-path (txids are derived locally, not from
// its return value) — default to a resolving promise so `.catch()` on the call site
// never throws synchronously on an undefined return.
jest.mock('@shared/overlayFunctions', () => ({ broadcastTX: jest.fn(async () => ({ txid: 'OVERLAY_TXID' })) }));
jest.mock('@shared/beefEncoding', () => ({ decodeBeef: jest.fn(() => [1, 2, 3]), encodeBeef: jest.fn(() => 'BEEF_B64') }));

let nonceQueue: string[] = [];
jest.mock('@shared/tokenDerivation', () => ({
  TOKEN_PROTOCOL: [2, 'monsterbattle token'],
  generateNonce: jest.fn(() => nonceQueue.shift() ?? 'NONCE_FALLBACK'),
  deriveRecipientKey: jest.fn(async () => 'USERKEY'),
  deriveSelfKey: jest.fn(async () => 'MINTKEY'),
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
  Transaction: {
    fromBEEF: jest.fn(),
    fromAtomicBEEF: jest.fn(() => ({})),
  },
  P2PKH: class { lock() { return { toHex: () => 'PS' }; } },
  Beef: class { mergeBeef() {} toBinary() { return []; } toBEEF() { return []; } },
  Hash: { hash160: () => 'H' },
}));

import request from 'supertest';
import { buildApp } from '@server/app';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';
import { publicKeyToGradient } from '@shared/publicKeyToColor';

const stubWallet = {
  createAction: jest.fn(),
  signAction: jest.fn(),
  getPublicKey: jest.fn(async () => ({ publicKey: 'PK' })),
};

// craft_wooden_sword: 5 common_wood + 2 common_leather -> common_dagger (tier 1).
// outputItem and per-material quantity/metadata are FORGED to prove the server ignores them.
const validBody = {
  recipeId: 'craft_wooden_sword',
  transferredMaterials: [
    { lootTableId: 'common_wood', tokenId: 'BATCHTX.0', quantity: 1000, quantityNeeded: 1, itemName: 'Forged', description: 'x', icon: 'x', rarity: 'legendary', tier: 5 },
    { lootTableId: 'common_leather', tokenId: 'BATCHTX.1', quantity: 1000, quantityNeeded: 1, itemName: 'Forged', description: 'x', icon: 'x', rarity: 'legendary', tier: 5 },
  ],
  outputItem: {
    lootTableId: 'excalibur',
    name: 'Excalibur',
    description: 'forged',
    icon: 'x',
    rarity: 'legendary',
    type: 'weapon',
    tier: 5,
    equipmentStats: { damageBonus: 9999 },
    crafted: { statRoll: 1.2 },
    borderGradient: { color1: 'a', color2: 'b' },
  },
  userIdentityKey: 'USER_ID_KEY',
  paymentTx: 'PAYMENT_B64',
  batchTransferBeef: 'BATCH_B64',
  transferNonce: 'N2',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
};

const defaultOwnedTokens = () => ({
  common_wood: { tokenId: 'WOODTX.0', quantity: 7, tier: 1 },
  common_leather: { tokenId: 'LEATHERTX.0', quantity: 2, tier: 1 },
});
const defaultBatchInputs = [
  { sourceTXID: 'WOODTX', sourceOutputIndex: 0 },
  { sourceTXID: 'LEATHERTX', sourceOutputIndex: 0 },
];

/** payment tx + batch-transfer tx — reached by every request past field validation. */
function seedPaymentAndBatchMocks(scriptHexes: string[], inputs = defaultBatchInputs) {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis: 100 }] })
    .mockReturnValueOnce({
      inputs,
      outputs: scriptHexes.map((hex) => ({ lockingScript: { toHex: () => hex } })),
      toBEEF: () => [1, 1],
    });
}

/** The two dependent wallet actions inside the queue (mint crafted item, then transfer). */
function seedEnqueueMocks() {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ inputs: [{ unlockingScript: { toHex: () => 'MINTUNLOCK' } }], sign: async () => {} }) // craftedItemTxToSign
    .mockReturnValueOnce({
      inputs: [
        { unlockingScript: { toHex: () => 'U0' } },
        { unlockingScript: { toHex: () => 'U1' } },
        { unlockingScript: { toHex: () => 'U2' } },
      ],
      sign: async () => {},
    }); // txToSign (2 materials + crafted item)

  // Both txids are now derived locally via .id('hex') on the fromAtomicBEEF result —
  // same values broadcastTX would have reported (it's just tx.id('hex')). The two
  // mockReturnValueOnce calls cover the calls made INSIDE enqueue (mint then transfer);
  // the mockReturnValue fallback covers the off-path re-decodes fired after the
  // response (route calls fromAtomicBEEF again per tx to build the overlay push).
  (Transaction.fromAtomicBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'MINTTX', toBEEF: () => [2, 2] }) // craftedItemTx (inside enqueue)
    .mockReturnValueOnce({ id: () => 'TRANSFERTX' }) // transferTx (inside enqueue)
    .mockReturnValue({ id: () => 'TRANSFERTX' }); // off-path broadcasts after response

  stubWallet.createAction
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF1', tx: [7, 7] } }) // mint
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF2', tx: [8, 8] } }); // transfer
  stubWallet.signAction
    .mockResolvedValueOnce({ tx: Uint8Array.from([9, 9]) }) // mint
    .mockResolvedValueOnce({ tx: Uint8Array.from([11, 11]) }); // transfer

  // mintNonce, itemNonce, changeNonce (only common_wood has change)
  nonceQueue = ['N_MINT', 'N_ITEM', 'N_CHANGE'];
}

describe('POST /api/crafting/mint-and-transfer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Transaction as any).fromBEEF = jest.fn();
    (Transaction as any).fromAtomicBEEF = jest.fn(() => ({}));
    nftInsertOne.mockResolvedValue({ insertedId: 'NFT_OID' });
    inventoryInsertOne.mockResolvedValue({ insertedId: 'INV_OID' });
    materialDeleteOne.mockResolvedValue({ deletedCount: 1 });
    materialUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
    stubWallet.getPublicKey.mockResolvedValue({ publicKey: 'PK' });
    nonceQueue = [];
    ownedTokens = defaultOwnedTokens();
    playerLevel = 1;
  });

  afterEach(() => jest.restoreAllMocks());

  it('400 on missing transferredMaterials', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      transferredMaterials: [],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing or invalid transferredMaterials' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on missing userIdentityKey', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      userIdentityKey: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on missing paymentTx', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      paymentTx: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing payment transaction' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on missing batchTransferBeef', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      batchTransferBeef: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing batch transfer BEEF' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on missing walletParams', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      walletParams: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing wallet derivation parameters' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on an unknown recipeId', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      recipeId: 'craft_free_excalibur',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Unknown recipe: craft_free_excalibur' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when a required material is missing from the transfer', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      transferredMaterials: [validBody.transferredMaterials[0]],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transferred materials do not match recipe craft_wooden_sword' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when an extra or duplicated material is transferred', async () => {
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      transferredMaterials: [...validBody.transferredMaterials, validBody.transferredMaterials[0]],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transferred materials do not match recipe craft_wooden_sword' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('403 when the player is below the recipe unlock level', async () => {
    playerLevel = 2; // craft_iron_sword unlocks at level 3
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send({
      ...validBody,
      recipeId: 'craft_iron_sword',
      transferredMaterials: [
        { lootTableId: 'rare_steel', tokenId: 'BATCHTX.0' },
        { lootTableId: 'common_wood', tokenId: 'BATCHTX.1' },
        { lootTableId: 'common_leather', tokenId: 'BATCHTX.2' },
      ],
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Recipe craft_iron_sword requires level 3' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the user owns no token for a required material', async () => {
    delete (ownedTokens as Record<string, unknown>).common_leather;
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather not owned' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the owned quantity is below the recipe requirement (client quantity ignored)', async () => {
    ownedTokens.common_leather.quantity = 1; // recipe needs 2; body claims 1000
    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Insufficient common_leather: need 2, have 1' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404 when a transferred material output is not found (rejects before enqueue)', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0']); // only one output — common_leather at vout 1 is missing

    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send(validBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Transfer output not found: BATCHTX.1' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when a transferred material is not locked to the server derived key (rejects before enqueue)', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'SOME_OTHER_LOCK_SCRIPT']);

    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather not locked to server derived key' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the batch transfer does not spend the owned material token', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [
      { sourceTXID: 'WOODTX', sourceOutputIndex: 0 },
      { sourceTXID: 'SOMEOTHERTX', sourceOutputIndex: 3 },
    ]);

    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather transfer does not spend owned token' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('mints the recipe output (ignoring forged outputItem) via the wallet queue, writes DB after, returns the success shape', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    seedEnqueueMocks();
    jest.spyOn(Math, 'random').mockReturnValue(0.75); // statRoll = 0.8 + 0.75 * 0.4 = 1.1

    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      nftId: 'NFT_OID',
      tokenId: 'TRANSFERTX.0',
      transferTransactionId: 'TRANSFERTX',
      materialChangeTokens: [{ lootTableId: 'common_wood', tokenId: 'TRANSFERTX.1', quantity: 2 }],
      statRoll: 1.1,
      rolledStats: { damageBonus: 1, autoClickRate: 0.55 },
      transferBeef: 'BEEF_B64',
      received: [
        { outputIndex: 0, keyId: 'N_ITEM', counterparty: 'SERVER_ID', tags: ['type:item'] },
        { outputIndex: 1, keyId: 'N_CHANGE', counterparty: 'SERVER_ID', tags: ['type:material'] },
      ],
    });

    // Both dependent wallet actions (mint crafted item, then transfer) ran as ONE unit
    // through the serialized queue.
    expect(enqueue).toHaveBeenCalledWith('craft', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(2);
    expect(stubWallet.signAction).toHaveBeenCalledTimes(2);

    // Inscribed metadata comes from the recipe + loot table, not the request body.
    const craftedMetadata = expect.objectContaining({
      itemName: 'Rusty Dagger',
      rarity: 'common',
      itemType: 'weapon',
      tier: 1,
      stats: { damageBonus: 1, autoClickRate: 0.5 },
      crafted: { statRoll: 1.1, craftedBy: 'u1' },
      visual: { borderGradient: publicKeyToGradient('u1') },
    });
    expect(ordLock).toHaveBeenCalledWith('MINTKEY', '', craftedMetadata, 'deploy+mint', 1);
    expect(ordLock).toHaveBeenCalledWith('USERKEY', 'MINTTX_0', craftedMetadata, 'transfer', 1);
    // Material change: owned 7 - recipe 5 = 2, with loot-table metadata.
    expect(ordLock).toHaveBeenCalledWith(
      'USERKEY',
      'BATCHTX_0',
      { name: 'material_token', lootTableId: 'common_wood', itemName: 'Wooden Plank', description: 'Rough lumber for crafting', icon: '🪵', rarity: 'common', tier: 1 },
      'transfer',
      2,
    );

    // DB writes happened AFTER the enqueue resolved.
    expect(nftInsertOne).toHaveBeenCalledTimes(1);
    expect(nftInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        lootTableId: 'common_dagger',
        name: 'Rusty Dagger',
        rarity: 'common',
        type: 'weapon',
        mintOutpoint: 'MINTTX.0',
        tokenId: 'TRANSFERTX.0',
        keyId: 'N_ITEM',
        counterparty: 'SERVER_ID',
      }),
    );
    expect(inventoryInsertOne).toHaveBeenCalledTimes(1);
    expect(inventoryInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        lootTableId: 'common_dagger',
        itemType: 'weapon',
        tier: 1,
        crafted: true,
        statRoll: 1.1,
        rolledStats: { damageBonus: 1, autoClickRate: 0.55 },
        borderGradient: publicKeyToGradient('u1'),
        tokenId: 'TRANSFERTX.0',
      }),
    );
    // common_leather was fully consumed (owned 2, needed 2) → deleted.
    expect(materialDeleteOne).toHaveBeenCalledTimes(1);
    expect(materialDeleteOne).toHaveBeenCalledWith({ userId: 'u1', lootTableId: 'common_leather' });
    // common_wood had leftover change → updated in place.
    expect(materialUpdateOne).toHaveBeenCalledTimes(1);
    expect(materialUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', lootTableId: 'common_wood' },
      expect.objectContaining({
        $set: expect.objectContaining({ tokenId: 'TRANSFERTX.1', quantity: 2, keyId: 'N_CHANGE', counterparty: 'SERVER_ID' }),
        $push: expect.objectContaining({
          updateHistory: expect.objectContaining({
            operation: 'subtract',
            previousQuantity: 7,
            newQuantity: 2,
            transactionId: 'TRANSFERTX',
            reason: 'Consumed in crafting recipe: craft_wooden_sword',
          }),
        }),
      }),
    );

    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(nftInsertOne.mock.invocationCallOrder[0]);
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(inventoryInsertOne.mock.invocationCallOrder[0]);

    // Overlay pushes for BOTH txs (intermediate mint + final transfer) are
    // fire-and-forget AFTER the response — flush pending microtasks so they've run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(2);
  });

  it('500s via the error handler when the wallet queue throws', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    enqueue.mockRejectedValueOnce(new Error('craft boom'));

    const res = await request(buildApp()).post('/api/crafting/mint-and-transfer').send(validBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(nftInsertOne).not.toHaveBeenCalled();
    expect(inventoryInsertOne).not.toHaveBeenCalled();
  });
});

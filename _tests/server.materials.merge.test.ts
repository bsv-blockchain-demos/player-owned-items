// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'u1'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
const getWalletQueue = jest.fn(async () => ({ enqueue }));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: () => getWalletQueue() }));

const findOne = jest.fn();
const updateOne = jest.fn(async () => ({ modifiedCount: 1 }));
// Inventory units are claimed with updateMany, then deleted (consumed) or unset (released).
const updateMany = jest.fn(async (_filter: any, _update: any) => ({ modifiedCount: 1 }));
const deleteMany = jest.fn(async (_filter: any) => ({ deletedCount: 1 }));
// The existing material token is claimed (pendingClaim) before the wallet queue.
const tokenUpdateMany = jest.fn(async (_filter: any, _update: any) => ({ modifiedCount: 1 }));
const listingFindOne = jest.fn(async (_filter: any): Promise<unknown> => null);
jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    materialTokensCollection: { findOne, updateOne, updateMany: tokenUpdateMany },
    userInventoryCollection: { updateMany, deleteMany },
    marketplaceItemsCollection: { findOne: listingFindOne },
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
jest.mock('@shared/tokenDerivation', () => ({
  TOKEN_PROTOCOL: [2, 'monsterbattle token'],
  generateNonce: jest.fn(() => 'NONCE'),
  deriveRecipientKey: jest.fn(async () => 'USERKEY'),
  deriveSelfKey: jest.fn(async () => 'MINTKEY'),
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
  P2PKH: class { lock() { return { toHex: () => 'PS' }; } },
  Beef: class { mergeBeef() {} toBinary() { return []; } toBEEF() { return []; } },
  Hash: { hash160: () => 'H' },
}));

import request from 'supertest';
import { inscribedScript } from './helpers/ordinalScript';
import { ObjectId } from 'mongodb';
import { buildApp } from '@server/app';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';

const stubWallet = {
  createAction: jest.fn(),
  signAction: jest.fn(),
  getPublicKey: jest.fn(async () => ({ publicKey: 'PK' })),
};

// addedQuantity and cosmetic metadata are FORGED: the server must add 1 (one owned
// inventory unit) with loot-table metadata.
const validBody = {
  transferredTokenId: 'TXID1.0',
  transferBeef: 'TRANSFER_B64',
  userIdentityKey: 'USER_ID_KEY',
  lootTableId: 'phoenix_feather',
  itemName: 'Forged Feather',
  description: 'forged',
  icon: 'x',
  rarity: 'common',
  tier: 1,
  addedQuantity: 1000,
  currentQuantity: 5,
  paymentTx: 'PAYMENT_B64',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
  reason: 'test add',
  acquiredFrom: 'sand_djinn',
  inventoryItemIds: ['507f1f77bcf86cd799439011'],
};

const EXISTING_OID = new ObjectId('64b0000000000000000000aa');
const ownedToken = { _id: EXISTING_OID, lootTableId: 'phoenix_feather', tier: 1, quantity: 5, tokenId: 'USERTOKEN.0' };

const inscribed = (hex: string, amt: number, lootTableId: string) => inscribedScript(hex, amt, { lootTableId });

/** payment tx + transfer tx — reached by every request past field validation. */
function seedPaymentAndTransferMocks(
  transferScriptHex: string,
  inputs = [{ sourceTXID: 'USERTOKEN', sourceOutputIndex: 0 }],
  amt = 5,
  lootTableId = 'phoenix_feather',
) {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis: 100 }] })
    .mockReturnValueOnce({
      id: () => 'TXID1',
      inputs,
      outputs: [{ lockingScript: inscribed(transferScriptHex, amt, lootTableId) }],
      toBEEF: () => [1, 1],
    });
}

/** The owned token is found only by the outpoint the transfer spends. */
const findBySpentOutpoint = async (q: { tokenId?: { $in?: string[] } }) =>
  q.tokenId?.$in?.includes(ownedToken.tokenId) ? ownedToken : null;

/** The claim id the route stamped on the inventory units (first updateMany call). */
const claimId = () => updateMany.mock.calls[0][1].$set.mintClaim as string;
/** The claim id the route stamped on the material token. */
const tokenClaimId = () => tokenUpdateMany.mock.calls[0][1].$set.pendingClaim as string;

/** The two dependent wallet actions inside the queue (mint, then merge). */
function seedEnqueueMocks() {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ inputs: [{ unlockingScript: { toHex: () => 'MINTUNLOCK' } }], sign: async () => {} })
    .mockReturnValueOnce({
      inputs: [
        { unlockingScript: { toHex: () => 'U0' } },
        { unlockingScript: { toHex: () => 'U1' } },
      ],
      sign: async () => {},
    });
  // Both txids are now derived locally via .id('hex') on the fromAtomicBEEF result —
  // same values broadcastTX would have reported (it's just tx.id('hex')). The two
  // mockReturnValueOnce calls cover the calls made INSIDE enqueue (mint then merge);
  // the mockReturnValue fallback covers the off-path re-decodes fired after the
  // response (route calls fromAtomicBEEF again per tx to build the overlay push).
  (Transaction.fromAtomicBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'MINTTX', toBEEF: () => [2, 2] }) // mintTx (inside enqueue)
    .mockReturnValueOnce({ id: () => 'MERGETX' }) // mergeTx (inside enqueue)
    .mockReturnValue({ id: () => 'MERGETX' }); // off-path broadcasts after response

  stubWallet.createAction
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF1', tx: [7, 7] } }) // mint
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF2', tx: [8, 8] } }); // merge
  stubWallet.signAction
    .mockResolvedValueOnce({ tx: Uint8Array.from([9, 9]) }) // mint
    .mockResolvedValueOnce({ tx: Uint8Array.from([11, 11]) }); // merge
}

describe('POST /api/materials/add-and-merge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Transaction as any).fromBEEF = jest.fn();
    (Transaction as any).fromAtomicBEEF = jest.fn(() => ({}));
    findOne.mockReset();
    findOne.mockImplementation(findBySpentOutpoint);
    getWalletQueue.mockImplementation(async () => ({ enqueue }));
    listingFindOne.mockResolvedValue(null);
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    updateMany.mockResolvedValue({ modifiedCount: 1 });
    tokenUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    deleteMany.mockResolvedValue({ deletedCount: 1 });
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
    stubWallet.getPublicKey.mockResolvedValue({ publicKey: 'PK' });
  });

  it('400 on missing required fields', async () => {
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send({
      ...validBody,
      transferredTokenId: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
    expect(findOne).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when lootTableId is not a material', async () => {
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send({ ...validBody, lootTableId: 'excalibur' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Not a material: excalibur' });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('400 when tier is not an integer 1-5', async () => {
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send({ ...validBody, tier: { $ne: null } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid tier' });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('400 when inventoryItemIds are empty', async () => {
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send({ ...validBody, inventoryItemIds: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid inventoryItemIds' });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('404 when material token not found', async () => {
    findOne.mockResolvedValueOnce(null);
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Material token not found or already consumed' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409 when quantity mismatch', async () => {
    findOne.mockResolvedValueOnce({ _id: EXISTING_OID, quantity: 999 });
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Quantity mismatch: expected 999, got 5' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when transfer output is not locked to the server public key (rejects before enqueue)', async () => {
    findOne.mockResolvedValueOnce(ownedToken);
    seedPaymentAndTransferMocks('SOME_OTHER_LOCK_SCRIPT');

    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transfer output not locked to server public key' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404 when the transfer does not spend an owned material token (no duplication via a junk token)', async () => {
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER', [{ sourceTXID: 'JUNKTOKEN', sourceOutputIndex: 0 }]);

    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Material token not found or already consumed' });
    // The token is resolved by the outpoint the transfer spends, not picked arbitrarily.
    expect(findOne).toHaveBeenCalledWith({
      userId: 'u1',
      lootTableId: 'phoenix_feather',
      tier: 1,
      consumed: { $ne: true },
      tokenId: { $in: ['JUNKTOKEN.0'] },
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['a foreign txid', 'OTHERTX.0'],
    ['a non-canonical vout', 'TXID1.00'],
  ])('400 when transferredTokenId names %s', async (_label, transferredTokenId) => {
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send({ ...validBody, transferredTokenId });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Transfer outpoint not in transfer transaction: ${transferredTokenId}` });
    expect(tokenUpdateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the transfer does not carry the whole owned token (on-chain split)', async () => {
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER', undefined, 1);
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transfer must carry the full token quantity (5)' });
    expect(tokenUpdateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the transfer is inscribed as another material than the owned token', async () => {
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER', undefined, 5, 'common_wood');
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transfer is inscribed as common_wood' });
    expect(tokenUpdateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409 when the material token is listed on the marketplace', async () => {
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    listingFindOne.mockResolvedValueOnce({ _id: 'LISTING', status: 'active' });
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material token is listed on the marketplace' });
    expect(tokenUpdateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('claims nothing when the wallet queue cannot be obtained', async () => {
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    getWalletQueue.mockRejectedValueOnce(new Error('queue down'));
    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);
    expect(res.status).toBe(500);
    expect(tokenUpdateMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('still returns the BEEF when the DB write fails after the merge, keeping both claims', async () => {
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    seedEnqueueMocks();
    updateOne.mockRejectedValueOnce(new Error('db down'));

    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      dbRecorded: false,
      mergedTokenId: 'MERGETX.0',
      transferBeef: 'BEEF_B64',
      received: { outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVER_ID', tags: ['type:material'] },
    }));
    // Claims held: the token is spent and the units are inscribed, so neither may be reused.
    expect(tokenUpdateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('409 when the material token is already in use by another request', async () => {
    findOne.mockResolvedValueOnce(ownedToken);
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    tokenUpdateMany.mockResolvedValueOnce({ modifiedCount: 0 });

    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material tokens are already in use' });
    expect(tokenUpdateMany).toHaveBeenCalledWith(
      { userId: 'u1', pendingClaim: { $exists: false }, $or: [{ _id: EXISTING_OID, tokenId: 'USERTOKEN.0' }] },
      { $set: { pendingClaim: expect.any(String) } },
    );
    expect(updateMany).not.toHaveBeenCalled(); // no inventory units claimed
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409 and releases both claims when not every inventory unit could be claimed', async () => {
    findOne.mockResolvedValueOnce(ownedToken);
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    updateMany.mockResolvedValueOnce({ modifiedCount: 0 });

    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Inventory items missing or already being minted' });
    expect(updateMany).toHaveBeenLastCalledWith({ mintClaim: claimId() }, { $unset: { mintClaim: '' } });
    expect(tokenUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: tokenClaimId() }, { $unset: { pendingClaim: '' } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('merges via the wallet queue as one dependent unit, writes DB after, returns the success shape', async () => {
    findOne.mockResolvedValueOnce(ownedToken);
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    seedEnqueueMocks();

    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      dbRecorded: true,
      mergedTokenId: 'MERGETX.0',
      mergeTransactionId: 'MERGETX',
      newQuantity: 6,
      previousQuantity: 5,
      addedQuantity: 1,
      transferBeef: 'BEEF_B64',
      received: { outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVER_ID', tags: ['type:material'] },
    });

    // Both dependent wallet actions ran as ONE unit through the serialized queue.
    expect(enqueue).toHaveBeenCalledWith('merge:material', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(2);
    expect(stubWallet.signAction).toHaveBeenCalledTimes(2);

    // DB writes happened AFTER the enqueue resolved.
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: EXISTING_OID, userId: 'u1', tokenId: 'USERTOKEN.0', pendingClaim: tokenClaimId() },
      expect.objectContaining({
        $unset: { pendingClaim: '' },
        $set: expect.objectContaining({
          tokenId: 'MERGETX.0',
          quantity: 6,
          previousTokenId: 'TXID1.0',
          // acquiredFrom is client-supplied and inscribed on chain, so the server ignores it.
          metadata: expect.objectContaining({ itemName: 'Phoenix Feather', rarity: 'legendary', icon: '🪶', acquiredFrom: [] }),
        }),
        $push: expect.objectContaining({
          updateHistory: expect.objectContaining({
            operation: 'add',
            previousQuantity: 5,
            newQuantity: 6,
            mergedFrom: ['TXID1.0', 'MINTTX.0'],
          }),
        }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ mintClaim: claimId() });
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(updateOne.mock.invocationCallOrder[0]);

    // Overlay pushes for BOTH txs (intermediate mint + final merge) are fire-and-forget
    // AFTER the response — flush pending microtasks so they've run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(2);
  });

  it('500s and releases the claim when the wallet queue throws', async () => {
    findOne.mockResolvedValueOnce(ownedToken);
    seedPaymentAndTransferMocks('LOCKSCRIPT_CONTAINS_PS_MARKER');
    enqueue.mockRejectedValueOnce(new Error('merge boom'));

    const res = await request(buildApp()).post('/api/materials/add-and-merge').send(validBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(updateOne).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({ mintClaim: claimId() }, { $unset: { mintClaim: '' } });
    expect(tokenUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: tokenClaimId() }, { $unset: { pendingClaim: '' } });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

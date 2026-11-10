// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'buyer'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: jest.fn(async () => ({ enqueue })) }));

const findOneAndUpdate = jest.fn();
const itemsUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
const beefsFindOne = jest.fn(async () => ({ beef: 'B' }));
const beefsDeleteOne = jest.fn(async () => ({ deletedCount: 1 }));
const inventoryUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
const materialUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
const usersFindOne = jest.fn(async () => ({ userId: 'buyer' }));
const playerStatsUpdateOne = jest.fn(async (_f: any, _u: any, _o?: any) => ({ modifiedCount: 0 }));

const endSession = jest.fn(async () => {});
const startSession = jest.fn(() => ({
  withTransaction: async (fn: () => Promise<void>) => fn(),
  endSession,
}));
const getClient = jest.fn(async () => ({ startSession }));

jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    marketplaceItemsCollection: { findOneAndUpdate, updateOne: itemsUpdateOne },
    marketplaceListingBeefsCollection: { findOne: beefsFindOne, deleteOne: beefsDeleteOne },
    userInventoryCollection: { updateOne: inventoryUpdateOne },
    materialTokensCollection: { updateOne: materialUpdateOne },
    usersCollection: { findOne: usersFindOne },
    playerStatsCollection: { updateOne: playerStatsUpdateOne },
  })),
  getClient,
}));

jest.mock('@server/lib/serverWallet', () => ({
  getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID'),
}));

jest.mock('@shared/overlayFunctions', () => ({
  broadcastTX: jest.fn(async () => ({ txid: 'PTX' })),
  getTransactionByTxID: jest.fn(),
}));
jest.mock('@shared/beefEncoding', () => ({ decodeBeef: jest.fn(() => [1, 2, 3]), encodeBeef: jest.fn(() => 'BEEF_B64') }));
jest.mock('@shared/tokenDerivation', () => ({
  generateNonce: jest.fn(() => 'NONCE'),
  deriveRecipientKey: jest.fn(async () => 'BUYERKEY'),
}));
jest.mock('@shared/ordinalP2PKH', () => ({
  OrdinalsP2PKH: class {
    lock() { return { toHex: () => 'TRANSFERLOCK' }; }
  },
}));
jest.mock('@bsv/wallet-helper', () => ({
  WalletP2PKH: class {
    unlock() { return { estimateLength: async () => 100 }; }
  },
  WalletOrdLock: class {
    purchaseUnlock() { return { estimateLength: async () => 400 }; }
  },
}));
jest.mock('@bsv/sdk', () => ({
  Transaction: {
    fromBEEF: jest.fn(),
    // The route derives the txid locally via .id('hex') — same value broadcastTX
    // would have reported, since broadcastTX itself is just tx.id('hex').
    fromAtomicBEEF: jest.fn(() => ({ id: () => 'PTX' })),
  },
  Script: { fromHex: jest.fn(() => 'ORDLOCK_SCRIPT_OBJ') },
  P2PKH: class {
    lock() { return { toHex: () => 'SELLERLOCK' }; }
  },
  Beef: class {
    mergeBeef() {}
    toBinary() { return []; }
  },
}));

import request from 'supertest';
import { ObjectId } from 'mongodb';
import { buildApp } from '@server/app';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';
import { decodeBeef } from '@shared/beefEncoding';

const stubWallet = {
  createAction: jest.fn(),
  signAction: jest.fn(),
};

const validBody = {
  listingId: '507f1f77bcf86cd799439011',
  buyerIdentityKey: 'BUYER_ID_KEY',
  paymentTx: 'PAYMENT_B64',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
};

const validListing = {
  sellerId: 'seller',
  ordLockOutpoint: 'ordtx.0',
  ordLockScript: '00',
  assetId: 'a',
  payAddress: 'addr',
  price: 100,
  itemName: 'Iron Sword',
  inventoryItemId: '507f1f77bcf86cd799439099',
};

/** payment tx (1st fromBEEF call) — reached by every request past the claim + own-listing + ordLock checks. */
function seedPaymentMock(satoshis: number) {
  (Transaction.fromBEEF as jest.Mock).mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis }] });
}

/** ordLockTransaction, txForLength, txToSign — the three fromBEEF calls made INSIDE the enqueue. */
function seedEnqueueMocks() {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ toBEEF: () => [1, 1] }) // ordLockTransaction (from beefDoc.beef)
    .mockReturnValueOnce({}) // txForLength
    .mockReturnValueOnce({
      inputs: [
        { unlockingScript: { toHex: () => 'ORDUNLOCK' } },
        { unlockingScript: { toHex: () => 'PAYUNLOCK' } },
      ],
      sign: async () => {},
    }); // txToSign

  stubWallet.createAction
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF', tx: [7, 7] } }) // pass 1
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF', tx: [7, 7] } }); // pass 2
  stubWallet.signAction.mockResolvedValueOnce({ tx: Uint8Array.from([2]) });
}

describe('POST /api/marketplace/purchase-listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Transaction as any).fromBEEF = jest.fn();
    (Transaction as any).fromAtomicBEEF = jest.fn(() => ({ id: () => 'PTX' }));
    findOneAndUpdate.mockReset();
    itemsUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    beefsFindOne.mockResolvedValue({ beef: 'B' });
    beefsDeleteOne.mockResolvedValue({ deletedCount: 1 });
    inventoryUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    materialUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    usersFindOne.mockResolvedValue({ userId: 'buyer' });
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
  });

  it('400 on missing required fields', async () => {
    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send({
      ...validBody,
      listingId: undefined,
    });
    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409 when the listing claim fails (not active)', async () => {
    findOneAndUpdate.mockResolvedValueOnce(null);

    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Listing is not available' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on own-listing purchase, and releases the claim', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...validListing, sellerId: 'buyer' });

    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'You cannot purchase your own listing' });
    expect(itemsUpdateOne).toHaveBeenCalledTimes(1);
    expect(itemsUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', pendingBuyerId: 'buyer' }),
      expect.objectContaining({ $set: { status: 'active' } }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 when the listing is missing OrdLock data, and releases the claim', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...validListing, ordLockOutpoint: undefined });

    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Listing is missing OrdLock data' });
    expect(itemsUpdateOne).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 on insufficient payment, and releases the claim', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...validListing });
    seedPaymentMock(50); // price 100 + 100 fee buffer required

    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid payment amount/);
    expect(itemsUpdateOne).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400 + releases the claim when the payment BEEF is malformed (throws during parse)', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...validListing });
    (decodeBeef as jest.Mock).mockImplementationOnce(() => { throw new Error('bad beef'); });

    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid payment transaction' });
    // The claim was already flipped to 'pending' before the parse — it must be released,
    // not stranded.
    expect(itemsUpdateOne).toHaveBeenCalledTimes(1);
    expect(itemsUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', pendingBuyerId: 'buyer' }),
      expect.objectContaining({ $set: { status: 'active' } }),
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it('502 + releases the claim when the wallet block throws', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...validListing });
    seedPaymentMock(300);
    enqueue.mockRejectedValueOnce(new Error('wallet boom'));

    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send(validBody);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Purchase failed; listing released' });
    expect(itemsUpdateOne).toHaveBeenCalledTimes(1);
    expect(itemsUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', pendingBuyerId: 'buyer' }),
      expect.objectContaining({ $set: { status: 'active' } }),
    );
    // Finalize (withTransaction) must never run on a rolled-back purchase.
    expect(getClient).not.toHaveBeenCalled();
  });

  it('claims -> enqueues the wallet work -> finalizes via withTransaction -> 200', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...validListing });
    seedPaymentMock(300);
    seedEnqueueMocks();

    const res = await request(buildApp()).post('/api/marketplace/purchase-listing').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      buyerTokenId: 'PTX.0',
      message: 'Iron Sword purchased for 100 satoshis',
      transferBeef: 'BEEF_B64',
      received: { outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVER_ID', tags: ['type:item'] },
    });

    expect(enqueue).toHaveBeenCalledWith('purchase', expect.any(Function));
    expect(stubWallet.createAction).toHaveBeenCalledTimes(2);
    expect(stubWallet.signAction).toHaveBeenCalledTimes(1);

    // Overlay push is fire-and-forget AFTER the response — flush pending microtasks
    // so the off-path broadcast (fired synchronously right after res.json) has run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(1);

    // Finalize ran inside the withTransaction session.
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(itemsUpdateOne).toHaveBeenCalledTimes(1);
    expect(itemsUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'sold', soldTo: 'buyer', payoutOutpoint: 'PTX.1' }) }),
      expect.anything(),
    );
    expect(beefsDeleteOne).toHaveBeenCalledTimes(1);
    expect(inventoryUpdateOne).toHaveBeenCalledTimes(1);
    expect(inventoryUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything() }),
      expect.objectContaining({ $set: expect.objectContaining({ userId: 'buyer', tokenId: 'PTX.0', keyId: 'NONCE', counterparty: 'SERVER_ID' }) }),
      expect.anything(),
    );
    expect(materialUpdateOne).not.toHaveBeenCalled();
    // The seller's slot may still point at the sold doc (equipped after listing); clear it in the same transaction.
    for (const slot of ['weapon', 'armor', 'accessory1', 'accessory2']) {
      expect(playerStatsUpdateOne).toHaveBeenCalledWith(
        { userId: 'seller', [`equippedItems.${slot}`]: new ObjectId('507f1f77bcf86cd799439099') },
        { $unset: { [`equippedItems.${slot}`]: '' } },
        expect.anything(),
      );
    }

    // Wallet work happened BEFORE the DB finalize.
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(itemsUpdateOne.mock.invocationCallOrder[0]);
  });
});

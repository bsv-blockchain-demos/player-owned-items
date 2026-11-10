// Self-contained mount: builds its own express() app (cookie-parser + express.json())
// and mounts marketplaceRouter directly at '/api/marketplace', independent of
// buildApp()/mountRoutes(). GET /my-sales + GET /listing/:id use the REAL requireSession
// middleware + a REAL JWT (via createJWT) set as the `verified` cookie, mirroring
// _tests/server.battle.test.ts. GET /items is public (no cookie). The three POST routes
// use the REAL requireAuthProof middleware; its lower-level dependencies (getServerWallet,
// authServer.verifyAuthProof, consumeNonce) are mocked, mirroring _tests/server.challenge.test.ts.
// connectToMongo, @bsv/sdk, and @bsv/wallet-helper are mocked so the list-item BEEF/OrdLock
// validation can be driven deterministically without touching real crypto.

jest.mock('@server/lib/serverWallet', () => ({
  getServerWallet: jest.fn().mockResolvedValue({}),
  getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID'),
}));
jest.mock('@shared/authProof', () => ({ authServer: { verifyAuthProof: jest.fn() } }));
jest.mock('@server/lib/authNonceStore', () => ({ consumeNonce: jest.fn() }));

jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: jest.fn(async () => ({ enqueue: jest.fn() })) }));
jest.mock('@shared/ordinalP2PKH', () => ({ OrdinalsP2PKH: class {} }));
jest.mock('@shared/overlayFunctions', () => ({
  broadcastTX: jest.fn(),
  getTransactionByTxID: jest.fn(),
}));
jest.mock('@shared/tokenDerivation', () => ({
  generateNonce: jest.fn(() => 'NONCE'),
  deriveRecipientKey: jest.fn(),
}));

const decodeBeef = jest.fn(() => [1, 2, 3]);
jest.mock('@shared/beefEncoding', () => ({ decodeBeef, encodeBeef: jest.fn(() => 'B64') }));

const ordLockLock = jest.fn();
jest.mock('@bsv/wallet-helper', () => ({
  WalletOrdLock: class { lock(...args: any[]) { return ordLockLock(...args); } },
  WalletP2PKH: class {},
}));

const fromBEEF = jest.fn();
const publicKeyFromString = jest.fn(() => ({ toAddress: () => 'PAY_ADDR' }));
jest.mock('@bsv/sdk', () => ({
  Transaction: { fromBEEF, fromAtomicBEEF: jest.fn() },
  PublicKey: { fromString: publicKeyFromString },
  Script: { fromHex: jest.fn() },
  P2PKH: class { lock(hash: string) { return { toHex: () => `PKH(${hash})` }; } },
  Hash: { hash160: (key: string) => `H160(${key})` },
  Beef: class {},
}));

// marketplaceItemsCollection.find() chain supports both my-sales (find().sort().toArray())
// and items (find().sort().limit().toArray()).
const itemsToArray = jest.fn(async () => [] as any[]);
const itemsLimit = jest.fn(() => ({ toArray: itemsToArray }));
const itemsSort = jest.fn(() => ({ toArray: itemsToArray, limit: itemsLimit }));
const itemsFind = jest.fn(() => ({ sort: itemsSort }));
const itemsFindOne = jest.fn();
const itemsInsertOne = jest.fn();
const itemsUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
const itemsDeleteOne = jest.fn(async () => ({ deletedCount: 1 }));

const beefsFindOne = jest.fn();
const beefsInsertOne = jest.fn(async () => ({}));
const beefsDeleteOne = jest.fn(async () => ({ deletedCount: 1 }));

const usersFindOne = jest.fn();
const nftLootUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
const userInventoryFindOne = jest.fn();
const userInventoryUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
const materialTokensFindOne = jest.fn();
const materialTokensUpdateOne = jest.fn(async (_filter: any, _update: any) => ({ modifiedCount: 1 }));
const playerStatsFindOne = jest.fn(async (): Promise<unknown> => null);

jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    marketplaceItemsCollection: {
      find: itemsFind,
      findOne: itemsFindOne,
      insertOne: itemsInsertOne,
      updateOne: itemsUpdateOne,
      deleteOne: itemsDeleteOne,
    },
    marketplaceListingBeefsCollection: {
      findOne: beefsFindOne,
      insertOne: beefsInsertOne,
      deleteOne: beefsDeleteOne,
    },
    usersCollection: { findOne: usersFindOne },
    nftLootCollection: { updateOne: nftLootUpdateOne },
    userInventoryCollection: { findOne: userInventoryFindOne, updateOne: userInventoryUpdateOne },
    materialTokensCollection: { findOne: materialTokensFindOne, updateOne: materialTokensUpdateOne },
    playerStatsCollection: { findOne: playerStatsFindOne },
  })),
  getClient: jest.fn(),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { inscribedScript } from './helpers/ordinalScript';
import { ObjectId } from 'mongodb';
import { deriveRecipientKey } from '@shared/tokenDerivation';
import { marketplaceRouter } from '@server/routes/marketplace';
import { createJWT } from '@server/lib/jwt';
import { authServer } from '@shared/authProof';

const mockVerify = (authServer as unknown as { verifyAuthProof: jest.Mock }).verifyAuthProof;

function appWithMarketplaceRouter() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/marketplace', marketplaceRouter);
  return app;
}

async function authCookie(userId = 'user-123') {
  const token = await createJWT({ userId, username: 'alice' });
  return `verified=${token}`;
}

/** Auth proof that verifies successfully for `user-123` (the requireAuthProof identity check). */
function seedValidProof() {
  mockVerify.mockResolvedValue({ valid: true, identityKey: 'user-123' });
}

const LISTING_OID = '507f1f77bcf86cd799439011';
const INVENTORY_OID = '507f1f77bcf86cd799439099';

describe('GET /api/marketplace/my-sales', () => {
  beforeEach(() => jest.clearAllMocks());

  it('401s with no verified cookie', async () => {
    const res = await request(appWithMarketplaceRouter()).get('/api/marketplace/my-sales');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('200s with the seller sold listings (happy path)', async () => {
    itemsToArray.mockResolvedValueOnce([
      {
        _id: new ObjectId(LISTING_OID),
        itemName: 'Iron Sword',
        itemIcon: '⚔️',
        rarity: 'rare',
        price: 500,
        payoutOutpoint: 'PTX.1',
        listingNonce: 'N1',
        payoutClaimed: false,
        soldAt: new Date(),
      },
    ]);

    const res = await request(appWithMarketplaceRouter())
      .get('/api/marketplace/my-sales')
      .set('Cookie', await authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.sales[0]).toMatchObject({ itemName: 'Iron Sword', price: 500, payoutOutpoint: 'PTX.1' });
    expect(itemsFind).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 'user-123', status: 'sold' }),
    );
  });
});

describe('GET /api/marketplace/listing/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('401s with no verified cookie', async () => {
    const res = await request(appWithMarketplaceRouter()).get(`/api/marketplace/listing/${LISTING_OID}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('200s with the listing (happy path, param routing works)', async () => {
    itemsFindOne.mockResolvedValueOnce({
      _id: new ObjectId(LISTING_OID),
      sellerId: 'user-123',
      itemName: 'Iron Sword',
      status: 'active',
    });
    beefsFindOne.mockResolvedValueOnce({ beef: 'BEEF_B64' });

    const res = await request(appWithMarketplaceRouter())
      .get(`/api/marketplace/listing/${LISTING_OID}`)
      .set('Cookie', await authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.listing.itemName).toBe('Iron Sword');
    expect(res.body.listing._id).toBe(LISTING_OID);
    expect(res.body.listing.ordLockBeef).toBe('BEEF_B64');
    // Param routing: the :id segment was correctly extracted and used in the query.
    expect(itemsFindOne).toHaveBeenCalledWith({ _id: new ObjectId(LISTING_OID), status: 'active' });
  });

  it('404s when the listing does not exist or is not active', async () => {
    itemsFindOne.mockResolvedValueOnce(null);

    const res = await request(appWithMarketplaceRouter())
      .get(`/api/marketplace/listing/${LISTING_OID}`)
      .set('Cookie', await authCookie());

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Listing not found or not active' });
  });
});

describe('GET /api/marketplace/items', () => {
  beforeEach(() => jest.clearAllMocks());

  it('200s with active items, no auth required (public happy path)', async () => {
    itemsToArray.mockResolvedValueOnce([
      { _id: new ObjectId(LISTING_OID), sellerId: 'seller', itemName: 'Iron Sword', rarity: 'rare', price: 500 },
    ]);

    const res = await request(appWithMarketplaceRouter()).get('/api/marketplace/items');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.items[0]).toMatchObject({ itemName: 'Iron Sword', rarity: 'rare', price: 500 });
    expect(itemsFind).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('narrows the query when ?rarity= is provided', async () => {
    itemsToArray.mockResolvedValueOnce([]);

    const res = await request(appWithMarketplaceRouter()).get('/api/marketplace/items?rarity=epic');

    expect(res.status).toBe(200);
    expect(itemsFind).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', rarity: 'epic' }));
  });
});

describe('POST /api/marketplace/list-item', () => {
  beforeEach(() => jest.clearAllMocks());

  const listBody = {
    proof: {},
    inventoryItemId: INVENTORY_OID,
    price: 500,
    userPublicKey: 'PUBKEY',
    listingNonce: 'LNONCE',
    ordLockOutpoint: 'ORDTX.0',
    ordLockScript: 'ORDSCRIPT_HEX',
    ordLockBeef: 'ORDLOCK_BEEF_B64',
  };

  it('401s with no proof present in the body', async () => {
    const res = await request(appWithMarketplaceRouter())
      .post('/api/marketplace/list-item')
      .set('Cookie', await authCookie())
      .send({ ...listBody, proof: undefined });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Auth proof required' });
    expect(itemsInsertOne).not.toHaveBeenCalled();
  });

  it('400s when price is invalid (valid proof, reaches handler; rejection branch)', async () => {
    seedValidProof();

    const res = await request(appWithMarketplaceRouter())
      .post('/api/marketplace/list-item')
      .set('Cookie', await authCookie())
      .send({ ...listBody, price: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Valid price is required' });
    expect(itemsInsertOne).not.toHaveBeenCalled();
  });

  it('200s and creates the listing (happy path, valid proof + BEEF validation)', async () => {
    seedValidProof();
    usersFindOne.mockResolvedValue({ userId: 'user-123', username: 'alice' });
    userInventoryFindOne.mockResolvedValue({
      _id: new ObjectId(INVENTORY_OID),
      userId: 'user-123',
      lootTableId: 'common_coin',
      tier: 1,
      nftLootId: new ObjectId(),
      tokenId: 'TOKENTX.0',
      mintOutpoint: 'TOKENTX.0',
    });
    itemsFindOne.mockResolvedValue(null); // no existing active listing
    itemsInsertOne.mockResolvedValueOnce({ insertedId: { toString: () => 'NEW_LISTING_ID' } });
    ordLockLock.mockResolvedValueOnce({ toHex: () => 'ORDSCRIPT_HEX' }); // matches ordLockScript
    fromBEEF.mockReturnValueOnce({
      inputs: [{ sourceTXID: 'TOKENTX', sourceOutputIndex: 0 }],
      outputs: [{ satoshis: 1, lockingScript: { toHex: () => 'ORDSCRIPT_HEX' } }],
    });

    const res = await request(appWithMarketplaceRouter())
      .post('/api/marketplace/list-item')
      .set('Cookie', await authCookie())
      .send(listBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      listingId: 'NEW_LISTING_ID',
      ordLockOutpoint: 'ORDTX.0',
    });
    expect(itemsInsertOne).toHaveBeenCalledTimes(1);
    expect(itemsInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerId: 'user-123',
        itemName: 'Gold Coin',
        price: 500,
        ordLockOutpoint: 'ORDTX.0',
        ordLockScript: 'ORDSCRIPT_HEX',
        status: 'active',
      }),
    );
    expect(beefsInsertOne).toHaveBeenCalledTimes(1);
    expect(userInventoryUpdateOne).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/marketplace/list-item (material token)', () => {
  const MATERIAL_OID = '64b0000000000000000000ab';
  const materialBody = {
    proof: {},
    materialTokenId: MATERIAL_OID.toUpperCase(), // case must not dodge listing lookups
    price: 500,
    userPublicKey: 'PUBKEY',
    listingNonce: 'LNONCE',
    ordLockOutpoint: 'ORDTX.0',
    ordLockScript: 'ORDSCRIPT_HEX',
    ordLockBeef: 'ORDLOCK_BEEF_B64',
  };
  const ownedMaterial = {
    _id: new ObjectId(MATERIAL_OID),
    userId: 'user-123',
    lootTableId: 'common_wood',
    tokenId: 'MATTX.0',
    mintOutpoint: 'MATTX.0',
    quantity: 4,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    seedValidProof();
    usersFindOne.mockResolvedValue({ userId: 'user-123', username: 'alice' });
    itemsFindOne.mockResolvedValue(null);
    materialTokensUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  function seedListingTx() {
    itemsInsertOne.mockResolvedValueOnce({ insertedId: { toString: () => 'NEW_LISTING_ID' } });
    ordLockLock.mockResolvedValueOnce({ toHex: () => 'ORDSCRIPT_HEX' });
    fromBEEF.mockReturnValueOnce({
      inputs: [{ sourceTXID: 'MATTX', sourceOutputIndex: 0 }],
      outputs: [{ satoshis: 1, lockingScript: { toHex: () => 'ORDSCRIPT_HEX' } }],
    });
  }

  const post = async () =>
    request(appWithMarketplaceRouter())
      .post('/api/marketplace/list-item')
      .set('Cookie', await authCookie())
      .send(materialBody);

  it('409s when a craft or merge holds a claim on the token', async () => {
    materialTokensFindOne.mockResolvedValueOnce({ ...ownedMaterial, pendingClaim: 'CLAIM' });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material tokens are already in use' });
    expect(itemsInsertOne).not.toHaveBeenCalled();
  });

  it('lists with a lowercase materialTokenId and moves the token only while it is unclaimed at its outpoint', async () => {
    materialTokensFindOne.mockResolvedValueOnce(ownedMaterial);
    seedListingTx();

    const res = await post();

    expect(res.status).toBe(200);
    expect(itemsFindOne).toHaveBeenCalledWith({ materialTokenId: MATERIAL_OID, status: 'active' });
    expect(itemsInsertOne).toHaveBeenCalledWith(expect.objectContaining({ materialTokenId: MATERIAL_OID }));
    expect(materialTokensUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(MATERIAL_OID), userId: 'user-123', tokenId: 'MATTX.0', pendingClaim: { $exists: false } },
      { $set: expect.objectContaining({ previousTokenId: 'MATTX.0', tokenId: 'ORDTX.0' }) },
    );
  });

  it('409s and removes the listing when the token was claimed after it was read', async () => {
    materialTokensFindOne.mockResolvedValueOnce(ownedMaterial);
    seedListingTx();
    materialTokensUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material tokens are already in use' });
    expect(itemsDeleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
    expect(beefsDeleteOne).toHaveBeenCalledWith({ listingId: 'NEW_LISTING_ID' });
  });
});

describe('POST /api/marketplace/list-item (item a craft may claim)', () => {
  const ITEM_OID = '64b0000000000000000000cd';
  const itemBody = {
    proof: {},
    inventoryItemId: ITEM_OID.toUpperCase(), // case must not dodge listing lookups
    price: 500,
    userPublicKey: 'PUBKEY',
    listingNonce: 'LNONCE',
    ordLockOutpoint: 'ORDTX.0',
    ordLockScript: 'ORDSCRIPT_HEX',
    ordLockBeef: 'ORDLOCK_BEEF_B64',
  };
  const ownedItem = {
    _id: new ObjectId(ITEM_OID),
    userId: 'user-123',
    lootTableId: 'spirit_crystal',
    tier: 1,
    nftLootId: new ObjectId(),
    tokenId: 'ITEMTX.0',
    mintOutpoint: 'ITEMTX.0',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    seedValidProof();
    usersFindOne.mockResolvedValue({ userId: 'user-123', username: 'alice' });
    itemsFindOne.mockResolvedValue(null);
    userInventoryUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  function seedListingTx() {
    itemsInsertOne.mockResolvedValueOnce({ insertedId: { toString: () => 'NEW_LISTING_ID' } });
    ordLockLock.mockResolvedValueOnce({ toHex: () => 'ORDSCRIPT_HEX' });
    fromBEEF.mockReturnValueOnce({
      inputs: [{ sourceTXID: 'ITEMTX', sourceOutputIndex: 0 }],
      outputs: [{ satoshis: 1, lockingScript: { toHex: () => 'ORDSCRIPT_HEX' } }],
    });
  }

  const post = async () =>
    request(appWithMarketplaceRouter())
      .post('/api/marketplace/list-item')
      .set('Cookie', await authCookie())
      .send(itemBody);

  it('409s when the item is equipped (the sale would leave the seller\'s slot on the buyer\'s item)', async () => {
    userInventoryFindOne.mockResolvedValueOnce(ownedItem);
    playerStatsFindOne.mockResolvedValueOnce({ userId: 'user-123', equippedItems: { accessory2: new ObjectId(ITEM_OID) } });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Unequip the item before listing it' });
    expect(itemsInsertOne).not.toHaveBeenCalled();
  });

  it('409s when a craft holds a claim on the item', async () => {
    userInventoryFindOne.mockResolvedValueOnce({ ...ownedItem, pendingClaim: 'CLAIM' });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material tokens are already in use' });
    expect(itemsInsertOne).not.toHaveBeenCalled();
  });

  it('lists with a lowercase inventoryItemId and moves the item only while it is unclaimed at its outpoint', async () => {
    userInventoryFindOne.mockResolvedValue(ownedItem); // read again before the token moves
    seedListingTx();

    const res = await post();

    expect(res.status).toBe(200);
    expect(itemsFindOne).toHaveBeenCalledWith({ inventoryItemId: ITEM_OID, status: 'active' });
    expect(itemsInsertOne).toHaveBeenCalledWith(expect.objectContaining({ inventoryItemId: ITEM_OID }));
    expect(userInventoryUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(ITEM_OID), userId: 'user-123', tokenId: 'ITEMTX.0', pendingClaim: { $exists: false } },
      { $set: expect.objectContaining({ tokenId: 'ORDTX.0' }) },
    );
    expect(nftLootUpdateOne).toHaveBeenCalledWith({ _id: ownedItem.nftLootId }, { $set: expect.objectContaining({ tokenId: 'ORDTX.0' }) });
  });

  it('409s and removes the listing when the item was claimed after it was read', async () => {
    userInventoryFindOne.mockResolvedValue(ownedItem); // read again before the token moves
    seedListingTx();
    userInventoryUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material tokens are already in use' });
    expect(itemsDeleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
    expect(beefsDeleteOne).toHaveBeenCalledWith({ listingId: 'NEW_LISTING_ID' });
    expect(nftLootUpdateOne).not.toHaveBeenCalled();
  });
});

describe('POST /api/marketplace/cancel-listing', () => {
  beforeEach(() => jest.clearAllMocks());

  const cancelBody = {
    proof: {},
    listingId: LISTING_OID,
    returnTokenId: 'RETURNTX.0',
    cancelBeef: 'CANCEL_BEEF_B64',
  };

  it('401s with no proof present in the body', async () => {
    const res = await request(appWithMarketplaceRouter())
      .post('/api/marketplace/cancel-listing')
      .set('Cookie', await authCookie())
      .send({ ...cancelBody, proof: undefined });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Auth proof required' });
    expect(itemsUpdateOne).not.toHaveBeenCalled();
  });

  // The seller derives the return key with (server, keyId); BRC-42 lets the server derive the same key.
  const SELLER_LOCK = 'xxPKH(H160(SELLERKEY))xx';
  const inscribed = (hex: string, amt: number, lootTableId: string, assetId: string) => inscribedScript(hex, amt, { lootTableId }, assetId);
  const listing = (over: Record<string, unknown> = {}) => ({
    _id: new ObjectId(LISTING_OID),
    sellerId: 'user-123',
    itemName: 'Iron Sword',
    status: 'active',
    ordLockOutpoint: 'CANCELSRC.0',
    ordLockScript: 'ORDSCRIPT_HEX',
    assetId: 'ASSET1',
    inventoryItemId: INVENTORY_OID,
    lootTableId: 'common_dagger',
    ...over,
  });
  // The listing's assetId is the token's mint id (set by list-item from mintOutpoint).
  const cancelTx = (lock = SELLER_LOCK, amt = 1, satoshis = 1, lootTableId = 'common_dagger', assetId = 'ASSET1') => ({
    id: () => 'RETURNTX',
    inputs: [{ sourceTXID: 'CANCELSRC', sourceOutputIndex: 0 }],
    outputs: [{ satoshis, lockingScript: inscribed(lock, amt, lootTableId, assetId) }],
  });
  const send = async (body: Record<string, unknown>) =>
    request(appWithMarketplaceRouter()).post('/api/marketplace/cancel-listing').set('Cookie', await authCookie()).send(body);
  const fullBody = { ...cancelBody, keyId: 'CANCELNONCE', counterparty: 'FORGED_COUNTERPARTY' };

  beforeEach(() => {
    (deriveRecipientKey as jest.Mock).mockResolvedValue('SELLERKEY');
    itemsUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    userInventoryUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('200s and returns the item to the seller key the server derives (happy path)', async () => {
    seedValidProof();
    itemsFindOne.mockResolvedValueOnce(listing());
    userInventoryFindOne.mockResolvedValueOnce(null);
    fromBEEF.mockReturnValueOnce(cancelTx());

    const res = await send(fullBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, returnTokenId: 'RETURNTX.0', message: 'Iron Sword listing cancelled' });
    expect(deriveRecipientKey).toHaveBeenCalledWith(expect.anything(), 'user-123', 'CANCELNONCE');
    // Only an active listing is cancelled, and the item moves only from the listing's OrdLock.
    expect(itemsUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(LISTING_OID), status: 'active' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'cancelled', tokenId: 'RETURNTX.0' }) }),
    );
    expect(userInventoryUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(INVENTORY_OID), userId: 'user-123', tokenId: 'CANCELSRC.0' },
      { $set: expect.objectContaining({ tokenId: 'RETURNTX.0', keyId: 'CANCELNONCE', counterparty: 'SERVER_ID' }) },
    );
    expect(beefsDeleteOne).toHaveBeenCalledWith({ listingId: LISTING_OID });
  });

  it.each([
    ['an outpoint in another tx', { returnTokenId: 'OTHERTX.0' }, cancelTx(), 'returnTokenId is not an output of the cancel transaction'],
    ['a non-canonical vout', { returnTokenId: 'RETURNTX.00' }, cancelTx(), 'returnTokenId is not an output of the cancel transaction'],
    ['a return output not locked to the seller', {}, cancelTx('xxPKH(H160(SOMEONE))xx'), 'Return output is not locked to the seller'],
    ['a return output carrying another amount', {}, cancelTx(SELLER_LOCK, 2), 'Return output must carry the listed amount (1)'],
    ['a return output of another value', {}, cancelTx(SELLER_LOCK, 1, 5), 'Cancel transaction return output must be 1 satoshi'],
    ['a return output inscribed as another item', {}, cancelTx(SELLER_LOCK, 1, 1, 'excalibur'), 'Return output is inscribed as excalibur'],
    ['a return output naming another asset id', {}, cancelTx(SELLER_LOCK, 1, 1, 'common_dagger', 'OTHER_0'), 'Return output names asset OTHER_0, not the listed ASSET1'],
  ])('400s on %s', async (_label, patch, tx, error) => {
    seedValidProof();
    itemsFindOne.mockResolvedValueOnce(listing());
    fromBEEF.mockReturnValueOnce(tx);

    const res = await send({ ...fullBody, ...patch });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(itemsUpdateOne).not.toHaveBeenCalled();
    expect(userInventoryUpdateOne).not.toHaveBeenCalled();
  });

  it('400s on a missing keyId (before any lookup)', async () => {
    seedValidProof();
    const res = await send({ ...fullBody, keyId: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields: listingId, returnTokenId, keyId' });
    expect(itemsFindOne).not.toHaveBeenCalled();
  });

  it('400s when the OrdLock is spent, but not by the input paired with the return output', async () => {
    seedValidProof();
    itemsFindOne.mockResolvedValueOnce(listing());
    fromBEEF.mockReturnValueOnce({
      ...cancelTx(),
      inputs: [{ sourceTXID: 'FUNDINGTX', sourceOutputIndex: 0 }, { sourceTXID: 'CANCELSRC', sourceOutputIndex: 0 }],
    });

    const res = await send(fullBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Return output is not paired with the listing ordLockOutpoint input' });
    expect(itemsUpdateOne).not.toHaveBeenCalled();
  });

  it('400s when another output also carries the listed asset', async () => {
    seedValidProof();
    itemsFindOne.mockResolvedValueOnce(listing());
    const tx = cancelTx();
    fromBEEF.mockReturnValueOnce({ ...tx, outputs: [...tx.outputs, { satoshis: 1, lockingScript: inscribed('USER_OWN_LOCK', 1, 'common_dagger', 'ASSET1') }] });

    const res = await send(fullBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Output 1 also carries asset ASSET1' });
    expect(itemsUpdateOne).not.toHaveBeenCalled();
  });

  it('checks a material listing returns its whole stack', async () => {
    seedValidProof();
    itemsFindOne.mockResolvedValueOnce(listing({ inventoryItemId: undefined, materialTokenId: '64b0000000000000000000ab', quantity: 4 }));
    fromBEEF.mockReturnValueOnce(cancelTx(SELLER_LOCK, 3));

    const res = await send(fullBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Return output must carry the listed amount (4)' });
  });

  it('409s and writes nothing else when the listing left active (e.g. a purchase claimed it)', async () => {
    seedValidProof();
    itemsFindOne.mockResolvedValueOnce(listing());
    fromBEEF.mockReturnValueOnce(cancelTx());
    itemsUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    const res = await send(fullBody);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Listing is no longer active' });
    expect(userInventoryUpdateOne).not.toHaveBeenCalled();
    expect(beefsDeleteOne).not.toHaveBeenCalled();
  });
});

describe('POST /api/marketplace/claim-proceeds', () => {
  beforeEach(() => jest.clearAllMocks());

  const claimBody = { proof: {}, listingId: LISTING_OID };

  it('401s with no proof present in the body', async () => {
    const res = await request(appWithMarketplaceRouter())
      .post('/api/marketplace/claim-proceeds')
      .set('Cookie', await authCookie())
      .send({ ...claimBody, proof: undefined });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Auth proof required' });
    expect(itemsUpdateOne).not.toHaveBeenCalled();
  });

  it('200s and marks the payout claimed (happy path)', async () => {
    seedValidProof();
    itemsFindOne.mockResolvedValueOnce({
      _id: new ObjectId(LISTING_OID),
      sellerId: 'user-123',
      status: 'sold',
    });

    const res = await request(appWithMarketplaceRouter())
      .post('/api/marketplace/claim-proceeds')
      .set('Cookie', await authCookie())
      .send(claimBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(itemsUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(LISTING_OID) },
      { $set: { payoutClaimed: true } },
    );
  });
});

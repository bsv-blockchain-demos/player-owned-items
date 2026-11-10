// Self-contained mount (Task 5 owns the real index.ts wiring): this test builds its own
// express() app (cookie-parser + express.json()) and mounts inventoryRouter directly at
// '/api/inventory', independent of buildApp()/mountRoutes(). Auth uses the REAL requireSession
// middleware + a REAL JWT (via createJWT) set as the `verified` cookie, mirroring
// _tests/server.battle.test.ts. connectToMongo is mocked per test; getLootItemById is the
// REAL implementation from @/lib/loot-table (lootId 'common_coin' exists in the loot table).

const userInventoryToArray = jest.fn(async () => [] as any[]);
const userInventorySort = jest.fn(() => ({ toArray: userInventoryToArray }));
const userInventoryFind = jest.fn(() => ({ sort: userInventorySort }));

const nftLootToArray = jest.fn(async () => [] as any[]);
const nftLootFind = jest.fn(() => ({ toArray: nftLootToArray }));

const materialTokensToArray = jest.fn(async () => [] as any[]);
const materialTokensFind = jest.fn(() => ({ toArray: materialTokensToArray }));

const marketplaceItemsToArray = jest.fn(async () => [] as any[]);
const marketplaceItemsFind = jest.fn(() => ({ toArray: marketplaceItemsToArray }));

const playerStatsFindOne = jest.fn(async (): Promise<unknown> => null);

jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    userInventoryCollection: { find: userInventoryFind },
    nftLootCollection: { find: nftLootFind },
    materialTokensCollection: { find: materialTokensFind },
    marketplaceItemsCollection: { find: marketplaceItemsFind },
    playerStatsCollection: { findOne: playerStatsFindOne },
  })),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { inventoryRouter } from '@server/routes/inventory';
import { createJWT } from '@server/lib/jwt';
import { ObjectId } from 'mongodb';

function appWithInventoryRouter() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/inventory', inventoryRouter);
  return app;
}

async function authCookie(userId = 'user-123') {
  const token = await createJWT({ userId, username: 'alice' });
  return `verified=${token}`;
}

describe('GET /api/inventory/get', () => {
  beforeEach(() => jest.clearAllMocks());

  it('401s with no verified cookie', async () => {
    const res = await request(appWithInventoryRouter()).get('/api/inventory/get');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('200s with the user inventory (happy path)', async () => {
    const inventoryItem = {
      _id: 'INV_1',
      userId: 'user-123',
      lootTableId: 'common_coin', // resolved via the REAL getLootItemById
      tier: 1,
      acquiredAt: new Date(),
      borderGradient: { color1: '#111111', color2: '#222222' },
    };
    userInventoryToArray.mockResolvedValueOnce([inventoryItem]);
    materialTokensToArray.mockResolvedValueOnce([]);

    const res = await request(appWithInventoryRouter())
      .get('/api/inventory/get')
      .set('Cookie', await authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalItems).toBe(1);
    expect(res.body.inventory).toHaveLength(1);
    expect(res.body.inventory[0].name).toBe('Gold Coin');
    expect(typeof res.body.inventory[0].inventoryId).toBe('string');
    expect(res.body.inventory[0].inventoryId).toBe('INV_1');
  });

  it('excludes items with an active marketplace listing when excludeListed=true', async () => {
    const inventoryItem = {
      _id: 'INV_1',
      userId: 'user-123',
      lootTableId: 'common_coin',
      tier: 1,
      acquiredAt: new Date(),
      borderGradient: { color1: '#111111', color2: '#222222' },
    };
    userInventoryToArray.mockResolvedValueOnce([inventoryItem]);
    materialTokensToArray.mockResolvedValueOnce([]);
    marketplaceItemsToArray.mockResolvedValueOnce([
      { sellerId: 'user-123', status: 'active', inventoryItemId: 'INV_1' },
    ]);

    const res = await request(appWithInventoryRouter())
      .get('/api/inventory/get?excludeListed=true')
      .set('Cookie', await authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalItems).toBe(0);
    expect(res.body.inventory).toEqual([]);
  });

  it('excludes equipped items when excludeEquipped=true', async () => {
    const equippedId = new ObjectId();
    const looseId = new ObjectId();
    const item = (_id: ObjectId) => ({ _id, userId: 'user-123', lootTableId: 'spirit_crystal', tier: 1, acquiredAt: new Date() });
    userInventoryToArray.mockResolvedValueOnce([item(equippedId), item(looseId)]);
    materialTokensToArray.mockResolvedValueOnce([]);
    playerStatsFindOne.mockResolvedValueOnce({ userId: 'user-123', equippedItems: { accessory1: equippedId } });

    const res = await request(appWithInventoryRouter())
      .get('/api/inventory/get?excludeEquipped=true')
      .set('Cookie', await authCookie());

    expect(res.status).toBe(200);
    expect(res.body.inventory.map((i: { inventoryId: string }) => i.inventoryId)).toEqual([looseId.toHexString()]);
    expect(playerStatsFindOne).toHaveBeenCalledWith({ userId: 'user-123' });
  });

  it('excludes items whose listing is mid-purchase (pending) when excludeListed=true', async () => {
    const id = new ObjectId();
    userInventoryToArray.mockResolvedValueOnce([{ _id: id, userId: 'user-123', lootTableId: 'common_coin', tier: 1, acquiredAt: new Date() }]);
    materialTokensToArray.mockResolvedValueOnce([]);
    marketplaceItemsToArray.mockResolvedValueOnce([{ sellerId: 'user-123', status: 'pending', inventoryItemId: id.toHexString() }]);

    const res = await request(appWithInventoryRouter())
      .get('/api/inventory/get?excludeListed=true')
      .set('Cookie', await authCookie());

    expect(res.body.inventory).toEqual([]);
    expect(marketplaceItemsFind).toHaveBeenCalledWith({ sellerId: 'user-123', status: { $in: ['active', 'pending'] } });
  });

  it("reports the inventory doc's tokenId, not a stale NFTLoot one (a purchase moves only the inventory doc)", async () => {
    const nftLootId = new ObjectId();
    userInventoryToArray.mockResolvedValueOnce([
      { _id: new ObjectId(), userId: 'user-123', lootTableId: 'spirit_crystal', tier: 1, acquiredAt: new Date(), nftLootId, tokenId: 'BUYERTX.0' },
    ]);
    nftLootToArray.mockResolvedValueOnce([{ _id: nftLootId, mintOutpoint: 'MINT.0', tokenId: 'ORDLOCKTX.0' }]);
    materialTokensToArray.mockResolvedValueOnce([]);

    const res = await request(appWithInventoryRouter())
      .get('/api/inventory/get')
      .set('Cookie', await authCookie());

    expect(res.body.inventory[0]).toEqual(expect.objectContaining({ tokenId: 'BUYERTX.0', currentTokenId: 'BUYERTX.0' }));
    // Only the doc's own mintOutpoint is the token's id; transfers are checked against it, so no NFTLoot fallback.
    expect(res.body.inventory[0].mintOutpoint).toBeUndefined();
    expect(res.body.inventory[0].mintTransactionId).toBe('MINT');
  });
});

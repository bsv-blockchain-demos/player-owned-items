// Self-contained mount: builds its own express() app (cookie-parser + express.json())
// and mounts inscriptionsRouter directly at '/api/inscriptions', independent of
// buildApp()/mountRoutes(). POST /apply uses the REAL requireAuthProof middleware; its
// lower-level dependencies (getServerWallet, authServer.verifyAuthProof, consumeNonce)
// are mocked, mirroring _tests/server.challenge.test.ts.
// connectToMongo and getLootItemById are mocked per test.

jest.mock('@server/lib/serverWallet', () => ({ getServerWallet: jest.fn().mockResolvedValue({}) }));
jest.mock('@shared/authProof', () => ({ authServer: { verifyAuthProof: jest.fn() } }));
jest.mock('@server/lib/authNonceStore', () => ({ consumeNonce: jest.fn() }));

const playerStatsFindOne = jest.fn();
const playerStatsUpdateOne = jest.fn(async () => ({ matchedCount: 1 }));
const userInventoryFindOne = jest.fn();
const userInventoryUpdateOne = jest.fn(async () => ({ matchedCount: 1 }));
const userInventoryDeleteOne = jest.fn(async () => ({ deletedCount: 1 }));

jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    playerStatsCollection: { findOne: playerStatsFindOne, updateOne: playerStatsUpdateOne },
    userInventoryCollection: {
      findOne: userInventoryFindOne,
      updateOne: userInventoryUpdateOne,
      deleteOne: userInventoryDeleteOne,
    },
  })),
}));

const getLootItemById = jest.fn();
jest.mock('@shared/loot-table', () => ({ getLootItemById }));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { inscriptionsRouter } from '@server/routes/inscriptions';
import { createJWT } from '@server/lib/jwt';
import { authServer } from '@shared/authProof';

const mockVerify = (authServer as unknown as { verifyAuthProof: jest.Mock }).verifyAuthProof;

function appWithInscriptionsRouter() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/inscriptions', inscriptionsRouter);
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

const equipmentId = new ObjectId().toHexString();
const scrollId = new ObjectId().toHexString();

function basePlayerStats() {
  return { userId: 'user-123', coins: 10000 };
}

function baseEquipment(overrides: Record<string, any> = {}) {
  return { _id: new ObjectId(equipmentId), userId: 'user-123', itemType: 'weapon', ...overrides };
}

function baseScroll(overrides: Record<string, any> = {}) {
  return { _id: new ObjectId(scrollId), userId: 'user-123', itemType: 'inscription_scroll', lootTableId: 'suffix_damage_common', ...overrides };
}

function baseScrollTemplate(overrides: Record<string, any> = {}) {
  return {
    lootId: 'suffix_damage_common',
    rarity: 'common',
    inscriptionData: { inscriptionType: 'damage', statValue: 3, slot: 'suffix', name: 'of Fury', description: 'Adds +3 damage' },
    ...overrides,
  };
}

describe('POST /api/inscriptions/apply', () => {
  beforeEach(() => jest.clearAllMocks());

  it('401s with no proof present in the body', async () => {
    const res = await request(appWithInscriptionsRouter())
      .post('/api/inscriptions/apply')
      .set('Cookie', await authCookie())
      .send({ equipmentId, scrollId }); // no `proof` field

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Auth proof required' });
    expect(userInventoryUpdateOne).not.toHaveBeenCalled();
  });

  it('200s, applies the inscription, and consumes the scroll (happy path)', async () => {
    seedValidProof();
    playerStatsFindOne.mockResolvedValueOnce(basePlayerStats());
    userInventoryFindOne
      .mockResolvedValueOnce(baseEquipment()) // equipment lookup
      .mockResolvedValueOnce(baseScroll()) // scroll lookup
      .mockResolvedValueOnce(baseEquipment({ suffix: { type: 'damage', value: 3, name: 'of Fury' } })); // post-update fetch
    getLootItemById.mockReturnValueOnce(baseScrollTemplate());

    const res = await request(appWithInscriptionsRouter())
      .post('/api/inscriptions/apply')
      .set('Cookie', await authCookie())
      .send({ proof: {}, equipmentId, scrollId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.goldCost).toBe(250);
    expect(res.body.equipment.suffix).toEqual({ type: 'damage', value: 3, name: 'of Fury' });

    // Writes re-check the docs are still unminted (a mint could land mid-request).
    expect(userInventoryUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(equipmentId), userId: 'user-123', nftLootId: { $not: { $type: 'objectId' } } },
      { $set: { suffix: { type: 'damage', value: 3, name: 'of Fury' } } },
    );
    expect(playerStatsUpdateOne).toHaveBeenCalledWith(
      { userId: 'user-123' },
      { $inc: { coins: -250 } },
    );
    expect(userInventoryDeleteOne).toHaveBeenCalledWith({ _id: new ObjectId(scrollId), userId: 'user-123', nftLootId: { $not: { $type: 'objectId' } } });
  });

  // A minted item's inscription lives on chain; a DB-only edit would desync it and let a
  // minted scroll be spent here and again (or listed / claimed by a craft) as a token.
  it.each([
    ['equipment', { equipment: { nftLootId: new ObjectId() }, scroll: {} }],
    ['scroll', { equipment: {}, scroll: { nftLootId: new ObjectId() } }],
  ])('400s when the %s is minted', async (_label, overrides) => {
    seedValidProof();
    playerStatsFindOne.mockResolvedValueOnce(basePlayerStats());
    userInventoryFindOne
      .mockResolvedValueOnce(baseEquipment(overrides.equipment))
      .mockResolvedValueOnce(baseScroll(overrides.scroll));
    getLootItemById.mockReturnValueOnce(baseScrollTemplate());

    const res = await request(appWithInscriptionsRouter())
      .post('/api/inscriptions/apply')
      .set('Cookie', await authCookie())
      .send({ proof: {}, equipmentId, scrollId });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Minted items are inscribed on chain through the Blacksmith' });
    expect(userInventoryUpdateOne).not.toHaveBeenCalled();
    expect(playerStatsUpdateOne).not.toHaveBeenCalled();
    expect(userInventoryDeleteOne).not.toHaveBeenCalled();
  });

  it('409s and charges nothing when the equipment was minted before the write', async () => {
    seedValidProof();
    playerStatsFindOne.mockResolvedValueOnce(basePlayerStats());
    userInventoryFindOne.mockResolvedValueOnce(baseEquipment()).mockResolvedValueOnce(baseScroll());
    getLootItemById.mockReturnValueOnce(baseScrollTemplate());
    userInventoryUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    const res = await request(appWithInscriptionsRouter())
      .post('/api/inscriptions/apply')
      .set('Cookie', await authCookie())
      .send({ proof: {}, equipmentId, scrollId });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Equipment changed during the request' });
    expect(playerStatsUpdateOne).not.toHaveBeenCalled();
    expect(userInventoryDeleteOne).not.toHaveBeenCalled();
  });

  it('400s on the autoclick/lifesteal exclusivity conflict (opposite slot already has the same type)', async () => {
    seedValidProof();
    playerStatsFindOne.mockResolvedValueOnce(basePlayerStats());
    userInventoryFindOne
      .mockResolvedValueOnce(baseEquipment({ prefix: { type: 'autoclick', value: 1, name: 'Eternal' } })) // equipment: has autoclick prefix
      .mockResolvedValueOnce(baseScroll({ lootTableId: 'suffix_autoclick_legendary' })); // scroll: autoclick suffix
    getLootItemById.mockReturnValueOnce(baseScrollTemplate({
      inscriptionData: { inscriptionType: 'autoclick', statValue: 1, slot: 'suffix', name: 'of Eternity', description: '...' },
    }));

    const res = await request(appWithInscriptionsRouter())
      .post('/api/inscriptions/apply')
      .set('Cookie', await authCookie())
      .send({ proof: {}, equipmentId, scrollId });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Cannot apply autoclick inscription',
      message: 'This equipment already has a autoclick prefix: "Eternal". You cannot have both autoclick prefix and suffix on the same item.',
    });
    expect(userInventoryUpdateOne).not.toHaveBeenCalled();
  });

  it('409s with an overwriteWarning when the target slot is already occupied', async () => {
    seedValidProof();
    playerStatsFindOne.mockResolvedValueOnce(basePlayerStats());
    userInventoryFindOne
      .mockResolvedValueOnce(baseEquipment({ suffix: { type: 'damage', value: 5, name: 'of Rage' } })) // equipment: suffix occupied
      .mockResolvedValueOnce(baseScroll()); // scroll targets suffix too
    getLootItemById.mockReturnValueOnce(baseScrollTemplate());

    const res = await request(appWithInscriptionsRouter())
      .post('/api/inscriptions/apply')
      .set('Cookie', await authCookie())
      .send({ proof: {}, equipmentId, scrollId });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      overwriteWarning: {
        slot: 'suffix',
        existingInscription: { type: 'damage', value: 5, name: 'of Rage' },
      },
      message: 'This equipment already has a suffix inscription: "of Rage". Set overwriteExisting=true to replace it.',
    });
    expect(userInventoryUpdateOne).not.toHaveBeenCalled();
  });

  it('404s when the equipment is not found or not owned by the user', async () => {
    seedValidProof();
    playerStatsFindOne.mockResolvedValueOnce(basePlayerStats());
    userInventoryFindOne.mockResolvedValueOnce(null); // equipment lookup fails

    const res = await request(appWithInscriptionsRouter())
      .post('/api/inscriptions/apply')
      .set('Cookie', await authCookie())
      .send({ proof: {}, equipmentId, scrollId });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Equipment not found or you do not own it' });
    expect(userInventoryUpdateOne).not.toHaveBeenCalled();
  });
});

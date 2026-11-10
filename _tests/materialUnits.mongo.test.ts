// Runs the claim helpers against a real mongod: the route tests mock Mongo and only
// pin filter shapes, which let a filter that matched nothing (nftLootId: null vs
// $exists:false) pass CI.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Collection } from 'mongodb';
import type { UserInventory, MaterialToken } from '@shared/types';
import {
  claimMaterialUnits,
  releaseMaterialUnits,
  consumeMaterialUnits,
  claimTokens,
  releaseTokens,
} from '@server/lib/materialUnits';

jest.setTimeout(120_000); // first run downloads a mongod binary

let mongod: MongoMemoryServer;
let client: MongoClient;
let units: Collection<UserInventory>;
let tokens: Collection<MaterialToken>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  const db = client.db('materialUnits');
  units = db.collection<UserInventory>('userInventory');
  tokens = db.collection<MaterialToken>('materialTokens');
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await units.deleteMany({});
  await tokens.deleteMany({});
});

/** Same shape select-loot inserts — note nftLootId: undefined, which the driver stores as null. */
async function lootDrop(overrides: Partial<UserInventory> = {}): Promise<ObjectId> {
  const { insertedId } = await units.insertOne({
    userId: 'u1',
    lootTableId: 'common_wood',
    itemType: 'material',
    nftLootId: undefined,
    tier: 1,
    borderGradient: { color1: 'a', color2: 'b' },
    acquiredAt: new Date(),
    ...overrides,
  } as UserInventory);
  return insertedId;
}

describe('claimMaterialUnits (real mongod)', () => {
  it('claims loot-drop units whose nftLootId was stored as null', async () => {
    const ids = [await lootDrop(), await lootDrop()];
    expect(await units.countDocuments({ nftLootId: { $type: 'null' } })).toBe(2); // driver stored undefined as null

    const claimId = await claimMaterialUnits(units, 'u1', 'common_wood', 1, ids);

    expect(claimId).toEqual(expect.any(String));
    expect(await units.countDocuments({ mintClaim: claimId! })).toBe(2);
  });

  it.each([
    ['minted as an NFT', { nftLootId: new ObjectId() }],
    ['already a token', { tokenId: 'abc.0' }],
    ['owned by someone else', { userId: 'u2' }],
    ['a different material', { lootTableId: 'common_leather' }],
    ['a different tier', { tier: 2 as const }],
  ])('claims nothing (all-or-none) when one unit is %s', async (_label, overrides) => {
    const ids = [await lootDrop(), await lootDrop(overrides)];

    expect(await claimMaterialUnits(units, 'u1', 'common_wood', 1, ids)).toBeNull();
    expect(await units.countDocuments({ mintClaim: { $exists: true } })).toBe(0);
  });

  it('lets only one of two overlapping concurrent claims win', async () => {
    const ids = [await lootDrop(), await lootDrop(), await lootDrop()];

    const results = await Promise.all([
      claimMaterialUnits(units, 'u1', 'common_wood', 1, ids),
      claimMaterialUnits(units, 'u1', 'common_wood', 1, ids),
    ]);

    // Overlapping claims can both fail, but can never both succeed.
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
    const winner = results.find(Boolean);
    expect(await units.countDocuments({ mintClaim: { $exists: true } })).toBe(winner ? 3 : 0);
  });

  it('release makes units claimable again; consume deletes only the claimed units', async () => {
    const ids = [await lootDrop(), await lootDrop()];
    const other = await lootDrop();

    const first = await claimMaterialUnits(units, 'u1', 'common_wood', 1, ids);
    await releaseMaterialUnits(units, first!);
    const second = await claimMaterialUnits(units, 'u1', 'common_wood', 1, ids);
    expect(second).toEqual(expect.any(String));

    await consumeMaterialUnits(units, second!);
    expect(await units.countDocuments({})).toBe(1);
    expect(await units.findOne({ _id: other })).not.toBeNull();
  });
});

describe('claimTokens (real mongod)', () => {
  async function token(tokenId: string, overrides: Partial<MaterialToken> = {}): Promise<ObjectId> {
    const { insertedId } = await tokens.insertOne({
      userId: 'u1',
      lootTableId: 'common_wood',
      itemName: 'Wooden Plank',
      tier: 1,
      tokenId,
      quantity: 5,
      ...overrides,
    } as MaterialToken);
    return insertedId;
  }

  it('claims tokens at their current outpoint', async () => {
    const a = await token('A.0');
    const b = await token('B.0');

    const claimId = await claimTokens(tokens, 'u1', [{ _id: a, tokenId: 'A.0' }, { _id: b, tokenId: 'B.0' }]);

    expect(await tokens.countDocuments({ pendingClaim: claimId! })).toBe(2);
  });

  it('claims nothing when a token has moved on (stale outpoint) or is already claimed', async () => {
    const a = await token('A.0');
    const b = await token('B.1'); // DB moved on from B.0
    expect(await claimTokens(tokens, 'u1', [{ _id: a, tokenId: 'A.0' }, { _id: b, tokenId: 'B.0' }])).toBeNull();
    expect(await tokens.countDocuments({ pendingClaim: { $exists: true } })).toBe(0);

    const held = await claimTokens(tokens, 'u1', [{ _id: a, tokenId: 'A.0' }]);
    expect(await claimTokens(tokens, 'u1', [{ _id: a, tokenId: 'A.0' }])).toBeNull();
    await releaseTokens(tokens, held!);
    expect(await claimTokens(tokens, 'u1', [{ _id: a, tokenId: 'A.0' }])).toEqual(expect.any(String));
  });

  it("does not claim another user's token", async () => {
    const a = await token('A.0', { userId: 'u2' });
    expect(await claimTokens(tokens, 'u1', [{ _id: a, tokenId: 'A.0' }])).toBeNull();
  });
});

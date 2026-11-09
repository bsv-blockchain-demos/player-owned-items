// Mock EVERY heavy import server/routes/items.ts pulls in transitively (mirrors the mint
// test) so buildApp() loads cleanly — the mint route's imports (requireAuthProof→@bsv/auth,
// walletQueue, WalletP2PKH, and overlayFunctions which instantiates a LookupResolver at
// module-load) would otherwise crash the record test under the partial @bsv/sdk mock.
jest.mock('@server/middleware/requireSession', () => ({
  requireSession: (req: any, _res: any, next: any) => { req.userId = 'USER_IDENTITY'; next(); },
}));
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: jest.fn() }));
jest.mock('@shared/overlayFunctions', () => ({ broadcastTX: jest.fn(), getTransactionByTxID: jest.fn() }));
jest.mock('@bsv/wallet-helper', () => ({ WalletP2PKH: class {} }));

const findOne = jest.fn();
const insertOne = jest.fn(async () => ({ insertedId: 'NFT_OID' }));
const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
const materialFindOne = jest.fn(async (_filter: any): Promise<unknown> => null);
jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    userInventoryCollection: { findOne, updateOne },
    nftLootCollection: { insertOne },
    materialTokensCollection: { findOne: materialFindOne },
  })),
}));

jest.mock('@server/lib/serverWallet', () => ({
  getServerWallet: jest.fn(async () => ({})),
  getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID'),
}));
jest.mock('@shared/tokenDerivation', () => ({
  generateNonce: jest.fn(() => 'NONCE'),
  deriveRecipientKey: jest.fn(async () => 'USERKEY'),
}));
jest.mock('@shared/ordinalP2PKH', () => ({
  OrdinalsP2PKH: class { lock() { return { toHex: () => 'EXPECTED_SCRIPT' }; } },
}));
jest.mock('@shared/beefEncoding', () => ({
  decodeBeef: jest.fn(() => [1, 2, 3]),
  encodeBeef: jest.fn(() => 'BEEF_B64'),
}));
jest.mock('@bsv/sdk', () => ({
  Transaction: { fromAtomicBEEF: jest.fn(), fromBEEF: jest.fn() },
}));

import request from 'supertest';
import { buildApp } from '@server/app';
import { Transaction } from '@bsv/sdk';

const fromAtomicBEEF = Transaction.fromAtomicBEEF as jest.Mock;

const body = {
  inventoryItemId: '507f1f77bcf86cd799439011',
  transferBeef: 'BEEF_B64',
  outpoint: 'MINTTX.0',
  keyId: 'NONCE',
  itemData: { name: 'game_item', itemName: 'Sword', description: 'd', icon: 'i', rarity: 'rare' },
};

// tx whose id matches the outpoint and whose output[0] script matches the reconstruction
function goodTx() {
  return { id: () => 'MINTTX', outputs: [{ lockingScript: { toHex: () => 'EXPECTED_SCRIPT' } }] };
}

describe('POST /api/items/mint-and-transfer/record', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    insertOne.mockResolvedValue({ insertedId: 'NFT_OID' });
    materialFindOne.mockResolvedValue(null);
  });

  it.each([
    ['stamped as a material', { lootTableId: 'common_wood', itemType: 'material' }],
    ['a material per the loot table', { lootTableId: 'common_wood' }],
  ])('400 when the inventory item is %s', async (_label, item) => {
    findOne.mockResolvedValueOnce(item);
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Materials are minted as material tokens' });
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('400 when itemData is not item-mint metadata (e.g. a quantity-1 material token mint)', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' });
    const res = await request(buildApp())
      .post('/api/items/mint-and-transfer/record')
      .send({ ...body, itemData: { name: 'material_token', lootTableId: 'common_wood' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Not an item mint' });
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('409 when the outpoint belongs to a material token', async () => {
    findOne
      .mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' })
      .mockResolvedValueOnce(null); // no inventory item holds it
    materialFindOne.mockResolvedValueOnce({ _id: 'MAT', mintOutpoint: 'MINTTX.0' });
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(409);
    expect(materialFindOne).toHaveBeenCalledWith({ $or: [{ tokenId: 'MINTTX.0' }, { mintOutpoint: 'MINTTX.0' }] });
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('400 on missing fields', async () => {
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send({});
    expect(res.status).toBe(400);
  });

  it('404 when the item is not owned', async () => {
    findOne.mockResolvedValueOnce(null);
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(404);
  });

  it('200 idempotent no-op when already recorded', async () => {
    findOne.mockResolvedValueOnce({ nftLootId: 'already' });
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(200);
    expect(res.body.alreadyRecorded).toBe(true);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('400 when the outpoint txid does not match the provided tx', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' });
    fromAtomicBEEF.mockReturnValueOnce({ id: () => 'DIFFERENT', outputs: [{ lockingScript: { toHex: () => 'EXPECTED_SCRIPT' } }] });
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(400);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('400 when the output is not the server-derived lock (forgery / tampered itemData)', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' });
    fromAtomicBEEF.mockReturnValueOnce({ id: () => 'MINTTX', outputs: [{ lockingScript: { toHex: () => 'SOMEONE_ELSES_SCRIPT' } }] });
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(400);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('409 when the outpoint is already recorded to another item (replay / fee-bypass)', async () => {
    findOne
      .mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' }) // target item: owned, not yet recorded
      .mockResolvedValueOnce({ _id: 'OTHER', tokenId: 'MINTTX.0' });     // another item already holds this outpoint
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(409);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('records the DB when provenance verifies', async () => {
    findOne.mockResolvedValueOnce({ lootTableId: 'lt1', itemType: 'weapon' });
    fromAtomicBEEF.mockReturnValueOnce(goodTx());
    const res = await request(buildApp()).post('/api/items/mint-and-transfer/record').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, dbRecorded: true, nftId: 'NFT_OID', tokenId: 'MINTTX.0' });
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });
});

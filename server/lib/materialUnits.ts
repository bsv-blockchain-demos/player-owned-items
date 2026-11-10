// Unminted material units are UserInventory docs, one doc per unit. The server
// derives mint quantities from them and claims them atomically, so concurrent
// mints can't count the same units twice. Material tokens are claimed the same
// way before any wallet action spends them.
import { ObjectId, type Collection, type Filter, type UpdateFilter } from 'mongodb';
import type { UserInventory, MaterialToken, MarketplaceItem } from '@shared/types';
import type { Tier } from '@shared/biome-config';

/** Distinct, well-formed ObjectIds, or null. */
export function parseInventoryIds(ids: unknown): ObjectId[] | null {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (!ids.every((id) => typeof id === 'string' && ObjectId.isValid(id) && id.length === 24)) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids.map((id) => new ObjectId(id));
}

export function isValidTier(tier: unknown): tier is Tier {
  return Number.isInteger(tier) && (tier as number) >= 1 && (tier as number) <= 5;
}

/** Claims every unit or none; returns the claim id, or null after releasing a partial claim. */
export async function claimMaterialUnits(
  col: Collection<UserInventory>,
  userId: string,
  lootTableId: string,
  tier: Tier,
  ids: ObjectId[],
): Promise<string | null> {
  const claimId = new ObjectId().toHexString();
  const { modifiedCount } = await col.updateMany(
    {
      _id: { $in: ids },
      userId,
      // $eq: a value from a request body is matched literally, never read as an operator.
      lootTableId: { $eq: lootTableId },
      tier: { $eq: tier },
      // Unminted = missing OR null; select-loot's `nftLootId: undefined` is stored as null.
      nftLootId: { $not: { $type: 'objectId' } },
      tokenId: { $not: { $type: 'string' } },
      mintClaim: { $exists: false },
    },
    { $set: { mintClaim: claimId } },
  );
  if (modifiedCount !== ids.length) {
    await releaseMaterialUnits(col, claimId);
    return null;
  }
  return claimId;
}

export async function releaseMaterialUnits(col: Collection<UserInventory>, claimId: string): Promise<void> {
  await col.updateMany({ mintClaim: claimId }, { $unset: { mintClaim: '' } });
}

export async function consumeMaterialUnits(col: Collection<UserInventory>, claimId: string): Promise<void> {
  await col.deleteMany({ mintClaim: claimId });
}

export const TOKEN_CLAIM_FAILED = 'Material tokens are already in use';

/** An on-chain token tracked in the DB: a MaterialToken or a minted UserInventory item. */
type ClaimableToken = MaterialToken | UserInventory;

/** Claims every token at its current outpoint, or none; returns the claim id, or null after releasing a partial claim. */
export async function claimTokens<T extends ClaimableToken>(
  col: Collection<T>,
  userId: string,
  tokens: Array<{ _id: ObjectId; tokenId: string }>,
): Promise<string | null> {
  const claimId = new ObjectId().toHexString();
  if (tokens.length === 0) return claimId; // an empty $or is a query error
  const { modifiedCount } = await col.updateMany(
    { userId, pendingClaim: { $exists: false }, $or: tokens.map(({ _id, tokenId }) => ({ _id, tokenId })) } as Filter<T>,
    { $set: { pendingClaim: claimId } } as UpdateFilter<T>,
  );
  if (modifiedCount !== tokens.length) {
    await releaseTokens(col, claimId);
    return null;
  }
  return claimId;
}

export async function releaseTokens<T extends ClaimableToken>(col: Collection<T>, claimId: string): Promise<void> {
  await col.updateMany({ pendingClaim: claimId } as Filter<T>, { $unset: { pendingClaim: '' } } as unknown as UpdateFilter<T>);
}

export const TOKEN_LISTED = 'Material token is listed on the marketplace';
export const ITEM_LISTED = 'Item is listed on the marketplace';

/** True if any of the docs has a live (active or mid-purchase) marketplace listing. */
export async function anyTokenListed(
  col: Collection<MarketplaceItem>,
  ids: ObjectId[],
  field: 'materialTokenId' | 'inventoryItemId' = 'materialTokenId',
): Promise<boolean> {
  const listing = await col.findOne({
    [field]: { $in: ids.map((id) => id.toHexString()) },
    status: { $in: ['active', 'pending'] },
  });
  return listing !== null;
}

/** The vout of `outpoint` if it is exactly `${txid}.${canonical vout}`, else null. */
export function voutOf(outpoint: string, txid: string): number | null {
  const [id, vout, ...rest] = outpoint.split('.');
  if (rest.length || id !== txid || !/^(0|[1-9]\d*)$/.test(vout ?? '')) return null;
  return Number(vout);
}

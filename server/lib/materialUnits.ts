// Unminted material units are UserInventory docs, one doc per unit. The server
// derives mint quantities from them and claims them atomically, so concurrent
// mints can't count the same units twice. Material tokens are claimed the same
// way before any wallet action spends them.
import { ObjectId, type Collection } from 'mongodb';
import type { UserInventory, MaterialToken } from '@shared/types';
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
      lootTableId,
      tier,
      nftLootId: { $exists: false },
      tokenId: { $exists: false },
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

/** Claims every token at its current outpoint, or none; returns the claim id, or null after releasing a partial claim. */
export async function claimMaterialTokens(
  col: Collection<MaterialToken>,
  userId: string,
  tokens: Array<{ _id: ObjectId; tokenId: string }>,
): Promise<string | null> {
  const claimId = new ObjectId().toHexString();
  const { modifiedCount } = await col.updateMany(
    { userId, pendingClaim: { $exists: false }, $or: tokens.map(({ _id, tokenId }) => ({ _id, tokenId })) },
    { $set: { pendingClaim: claimId } },
  );
  if (modifiedCount !== tokens.length) {
    await releaseMaterialTokens(col, claimId);
    return null;
  }
  return claimId;
}

export async function releaseMaterialTokens(col: Collection<MaterialToken>, claimId: string): Promise<void> {
  await col.updateMany({ pendingClaim: claimId }, { $unset: { pendingClaim: '' } });
}

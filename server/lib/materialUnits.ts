// Unminted material units are UserInventory docs, one doc per unit. The server
// derives mint quantities from them and claims them atomically, so concurrent
// mints can't count the same units twice. Material tokens are claimed the same
// way before any wallet action spends them.
import { ObjectId, type Collection } from 'mongodb';
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
      lootTableId,
      tier,
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

export const TOKEN_LISTED = 'Material token is listed on the marketplace';

/** True if any of the tokens has a live (active or mid-purchase) marketplace listing. */
export async function anyTokenListed(col: Collection<MarketplaceItem>, ids: ObjectId[]): Promise<boolean> {
  const listing = await col.findOne({
    materialTokenId: { $in: ids.map((id) => id.toHexString()) },
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

/** The amount of an OrdinalsP2PKH bsv-20 transfer inscription, or null if the script carries none. */
export function transferAmount(script: { chunks: Array<{ data?: number[] }> }): number | null {
  const [, , marker, , , , body] = script.chunks;
  if (!marker?.data || !body?.data || Buffer.from(marker.data).toString('utf8') !== 'ord') return null;
  try {
    const inscription = JSON.parse(Buffer.from(body.data).toString('utf8'));
    return inscription?.op === 'transfer' && Number.isInteger(inscription.amt) ? inscription.amt : null;
  } catch {
    return null;
  }
}

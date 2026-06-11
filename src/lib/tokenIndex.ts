import type { Collection } from 'mongodb';

export interface TokenDerivationRecord {
  keyId: string;        // the nonce
  counterparty: string; // identity key the output was locked toward (or 'self')
}

/** Persist a token's derivation on its DB record. `filter` must match one document. */
export async function recordTokenDerivation(
  collection: Collection<any>,
  filter: Record<string, unknown>,
  derivation: TokenDerivationRecord,
): Promise<void> {
  await collection.updateOne(filter, {
    $set: { keyId: derivation.keyId, counterparty: derivation.counterparty },
  });
}

/** Read a token's derivation by outpoint; null for legacy tokens (no nonce → caller uses the legacy unlock). */
export async function getTokenDerivation(
  collection: Collection<any>,
  tokenId: string,
): Promise<TokenDerivationRecord | null> {
  const doc = await collection.findOne({ tokenId });
  if (!doc || !doc.keyId) return null;
  return { keyId: doc.keyId, counterparty: doc.counterparty };
}

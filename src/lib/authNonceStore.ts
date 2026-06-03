import type { Collection } from 'mongodb';
import { getDatabase } from './mongodb';

// Single-use store for auth-proof nonces. A record is kept (TTL-evicted) until
// the proof expires, giving replay protection without unbounded growth.
let ready: Promise<Collection> | null = null;

async function getAuthNonces(): Promise<Collection> {
  if (!ready) {
    ready = (async () => {
      const db = await getDatabase();
      const col = db.collection('auth_nonces');
      await col.createIndex({ nonce: 1 }, { unique: true });
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      return col;
    })();
  }
  return ready;
}

/** Records a nonce; returns false if already used (replay). Matches @bsv/auth's ConsumeNonce. */
export async function consumeNonce(nonce: string, expiresAt: Date): Promise<boolean> {
  const col = await getAuthNonces();
  try {
    await col.insertOne({ nonce, expiresAt });
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000) {
      return false;
    }
    throw error;
  }
}

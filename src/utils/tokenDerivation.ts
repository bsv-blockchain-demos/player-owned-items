// src/utils/tokenDerivation.ts
import { Utils, Random } from '@bsv/sdk';
import type { WalletProtocol, WalletInterface } from '@bsv/sdk';

/** App-wide signing protocol for token outputs. Security level 2 = counterparty-bound. */
export const TOKEN_PROTOCOL: WalletProtocol = [2, 'monsterbattle token'];

export interface Derivation {
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string; // identity public key hex, or the literal 'self'
}

/** Fresh per-output nonce: base64 of 16 random bytes. */
export function generateNonce(): string {
  return Utils.toBase64(Random(16));
}

/** Lock key for a recipient (you're the sender); only they can derive the matching private key. */
export async function deriveRecipientKey(
  senderWallet: WalletInterface,
  recipientIdentityKey: string,
  nonce: string,
): Promise<string> {
  const { publicKey } = await senderWallet.getPublicKey({
    protocolID: TOKEN_PROTOCOL,
    keyID: nonce,
    counterparty: recipientIdentityKey,
    forSelf: false,
  });
  return publicKey;
}

/** Derive the public key used to LOCK an output to yourself (counterparty 'self'). */
export async function deriveSelfKey(
  wallet: WalletInterface,
  nonce: string,
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({
    protocolID: TOKEN_PROTOCOL,
    keyID: nonce,
    counterparty: 'self',
  });
  return publicKey;
}

/**
 * Lock a token to YOURSELF so it later unlocks with `counterparty` — matches how
 * received tokens are keyed (e.g. a seller reclaiming their own listing on cancel).
 */
export async function deriveOwnKey(
  wallet: WalletInterface,
  counterpartyIdentityKey: string,
  nonce: string,
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({
    protocolID: TOKEN_PROTOCOL,
    keyID: nonce,
    counterparty: counterpartyIdentityKey,
    forSelf: true,
  });
  return publicKey;
}

/**
 * Server-side wallet for minting items
 * This wallet is the single source of truth for all game item mints
 *
 * All legitimate items in the game are first minted by this server wallet,
 * then transferred to users. This prevents users from creating fraudulent items.
 */

import { WalletClient, PrivateKey } from '@bsv/sdk';
import { makeWallet } from '../../_tests/helpers/mockWallet';

let serverWallet: WalletClient | null = null;

/**
 * Get or create the singleton server wallet instance
 * Uses environment variables for secure key storage
 */
export async function getServerWallet(): Promise<WalletClient> {
  if (serverWallet) {
    return serverWallet;
  }

  const privateKey = process.env.SERVER_PRIVATE_KEY;
  const storageURL = process.env.WALLET_STORAGE_URL || 'https://store-us-1.bsvb.tech';
  const chain = (process.env.BSV_NETWORK as 'test' | 'main') || 'main';

  if (!privateKey) {
    throw new Error('SERVER_PRIVATE_KEY environment variable not set');
  }

  // Create server wallet
  serverWallet = await makeWallet(chain, storageURL, privateKey);

  console.log('Server wallet initialized for minting');
  return serverWallet;
}

/**
 * Get server wallet public key for verification (derived key)
 */
export async function getServerPublicKey(): Promise<string> {
  const wallet = await getServerWallet();
  const { publicKey } = await wallet.getPublicKey({
    protocolID: [0, "monsterbattle"],
    keyID: "0",
    counterparty: "self",
  });
  return publicKey;
}

/**
 * Get server wallet identity public key (derived from env private key)
 * Use this for payment transactions to avoid BIP32 counterparty derivation issues
 */
export async function getServerIdentityPublicKey(): Promise<string> {
  const wallet = await getServerWallet();
  const { publicKey } = await wallet.getPublicKey({
    identityKey: true,
  });
  return publicKey;
}

/**
 * Get server wallet identity private key (from env)
 * BACKEND ONLY - Never expose to client!
 * Use this for unlocking plain P2PKH payment inputs
 */
export function getServerIdentityPrivateKey(): PrivateKey {
  const privateKeyHex = process.env.SERVER_PRIVATE_KEY;
  if (!privateKeyHex) {
    throw new Error('SERVER_PRIVATE_KEY environment variable not set');
  }
  return PrivateKey.fromString(privateKeyHex, 'hex');
}

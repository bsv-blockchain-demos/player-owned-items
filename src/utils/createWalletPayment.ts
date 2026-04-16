/**
 * Reusable utility for creating WalletP2PKH payment outputs to the server
 *
 * This utility creates a payment transaction using WalletP2PKH (not plain P2PKH)
 * which allows the server to unlock using wallet derivation parameters.
 *
 * Flow:
 * 1. Get derivation for payment (protocolID, keyID)
 * 2. Set counterparty to server identity key
 * 3. Create WalletP2PKH locked output
 * 4. Return payment BEEF + wallet params for server unlocking
 *
 * Usage across routes:
 * - materials/mint-and-transfer
 * - items/mint-and-transfer
 * - crafting/mint-and-transfer
 * - equipment/mint-and-transfer
 */

import { WalletClient } from '@bsv/sdk';
import { WalletP2PKH, getDerivation } from '@bsv/wallet-helper';

export interface WalletPaymentParams {
  protocolID: [number, string];
  keyID: string;
  counterparty: string;  // Server identity key
}

export interface WalletPaymentResult {
  paymentTx: number[];        // Transaction BEEF
  paymentTxId: string;        // Transaction ID
  walletParams: WalletPaymentParams;  // For server unlocking
}

/**
 * Create a WalletP2PKH payment output to the server
 *
 * @param wallet - Connected WalletClient
 * @param serverIdentityKey - Server's identity public key (for counterparty)
 * @param satoshis - Payment amount in satoshis
 * @param description - Payment description
 * @returns Payment transaction BEEF and wallet parameters for server unlocking
 */
export async function createWalletPayment(
  wallet: WalletClient,
  serverIdentityKey: string,
  satoshis: number,
  description: string
): Promise<WalletPaymentResult> {
  // Validate wallet
  if (!wallet) {
    throw new Error('Wallet not connected');
  }

  const isAuthenticated = await wallet.isAuthenticated();
  if (!isAuthenticated) {
    throw new Error('Wallet not authenticated');
  }

  // Get derivation for payment output
  const derivation = getDerivation();

  // Get user's identity key for server unlock (counterparty)
  const { publicKey: userIdentityKey } = await wallet.getPublicKey({ identityKey: true });

  // Params for CLIENT to create the lock (counterparty = server)
  const lockParams = {
    protocolID: derivation.protocolID,
    keyID: derivation.keyID,
    counterparty: serverIdentityKey,
  };

  // Params for SERVER to unlock (counterparty = user) - ECDH key exchange
  const unlockParams = {
    protocolID: derivation.protocolID,
    keyID: derivation.keyID,
    counterparty: userIdentityKey,
  };

  console.log('🔑 [WALLET-PAYMENT] Creating payment with ECDH key exchange:', {
    protocolID: derivation.protocolID,
    keyID: derivation.keyID,
    clientLockCounterparty: serverIdentityKey?.substring(0, 20) + '...',
    serverUnlockCounterparty: userIdentityKey?.substring(0, 20) + '...',
  });

  // Create WalletP2PKH locking script with derivation
  const walletP2pkh = new WalletP2PKH(wallet);
  const paymentLockingScript = await walletP2pkh.lock({
    walletParams: lockParams,
  });

  console.log('🔒 [WALLET-PAYMENT] Created WalletP2PKH locking script:', {
    scriptLength: paymentLockingScript.toHex().length / 2,
  });

  // Create payment action
  const paymentAction = await wallet.createAction({
    description,
    outputs: [{
      outputDescription: `Payment to server (${satoshis} sats)`,
      lockingScript: paymentLockingScript.toHex(),
      satoshis,
    }],
    options: { 
      randomizeOutputs: false,
      acceptDelayedBroadcast: false,
    },
  });

  if (!paymentAction.txid) {
    throw new Error('Failed to create payment transaction');
  }

  console.log('✅ [WALLET-PAYMENT] Payment transaction created:', {
    txid: paymentAction.txid,
    satoshis,
    protocolID: derivation.protocolID,
    keyID: derivation.keyID,
  });

  return {
    paymentTx: Array.from(paymentAction.tx!),
    paymentTxId: paymentAction.txid,
    walletParams: unlockParams,  // Server uses these params with user identity as counterparty
  };
}

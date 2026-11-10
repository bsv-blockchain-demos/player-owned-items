import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { WalletClient, Transaction } from '@bsv/sdk';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { createWalletPayment } from '@/utils/createWalletPayment';
import { broadcastTX } from './useOverlayFunctions';
import { fetchTokenSourceTx } from '@/shared/fetchTokenSourceTx';
import { encodeBeef, decodeBeef } from '@shared/beefEncoding';
import { internalizeToBasket } from '@/shared/internalizeToBasket';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey } from '@shared/tokenDerivation';
import { apiFetchStepUp } from '@/lib/apiFetchStepUp';

/**
 * Hook for updating material token quantities on the BSV blockchain
 *
 * Updates existing material tokens by creating new transactions that reference
 * the previous token state and update the quantity. This allows tracking
 * material collection and consumption on-chain.
 *
 * Uses the SAME unified metadata structure as useCreateMaterialToken.
 * All material operations use name: 'material_token' regardless of create/update.
 * Transaction inputs/outputs provide immutable history (previous quantity, operation, timestamp).
 *
 * Only 'add' exists: the server derives quantities (add-and-merge). Client-declared
 * subtract/set was removed (CRIT-2); crafting consumes materials server-side.
 *
 * @example
 * const { updateMaterialToken, isUpdating, error } = useUpdateMaterialToken();
 *
 * await updateMaterialToken({
 *   wallet: connectedWallet,
 *   updates: [{ lootTableId: 'iron_ore', operation: 'add', inventoryItemIds: [...], ... }],
 * });
 */

export type MaterialUpdateOperation = 'add';

export interface MaterialTokenUpdate {
  name: string;                  // Ordinal metadata header name
  lootTableId: string;           // Material type to update
  itemName: string;              // Material name
  description: string;           // Material description (for metadata)
  icon: string;                  // Emoji icon
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  tier?: number;                 // Material tier (if applicable)
  currentTokenId: string;        // Current token ID on blockchain
  mintOutpoint?: string;         // The stack's BSV-21 id, carried by every transfer
  currentQuantity: number;       // Current quantity (for validation)
  keyId?: string;                // Derivation nonce used to lock this token (absent = legacy)
  counterparty?: string;         // Counterparty used to lock this token (absent = legacy)
  operation: MaterialUpdateOperation;
  quantity: number;              // Amount to add/subtract/set
  inventoryItemIds?: string[];   // UserInventory IDs to consume after update
  reason?: string;               // Optional: Why this update (e.g., "crafting steel_sword")
  acquiredFrom?: {               // Optional: For 'add' operations, track where material came from (game data only)
    monsterName: string;
    biome: string;
    quantity: number;            // How many from this source
  };
}

export interface UpdateMaterialTokenParams {
  wallet: WalletClient;
  updates: MaterialTokenUpdate[]; // Support batch updates
}

export interface MaterialUpdateResult {
  lootTableId: string;
  itemName: string;              // Material name
  previousTokenId: string;       // Token ID before update
  newTokenId?: string;           // New token ID after update
  transactionId?: string;        // BSV transaction ID
  previousQuantity: number;
  newQuantity: number;
  operation: MaterialUpdateOperation;
  success: boolean;
  error?: string;
}

export interface UpdateMaterialTokenResult {
  results: MaterialUpdateResult[];
  success: boolean;
  error?: string;
}

export function useUpdateMaterialToken() {
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * For each update: transfer the existing token to the server, then add-and-merge
   * mints the added units and returns the merged token for internalization.
   */
  const updateMaterialToken = useCallback(async (
    params: UpdateMaterialTokenParams
  ): Promise<UpdateMaterialTokenResult> => {
    setIsUpdating(true);
    setError(null);

    try {
      const { wallet, updates } = params;

      // Validate wallet
      if (!wallet) {
        throw new Error('Wallet not connected');
      }

      const isAuthenticated = await wallet.isAuthenticated();
      if (!isAuthenticated) {
        throw new Error('Wallet not authenticated');
      }

      // Identity key is the derivation counterparty the server locks toward
      const { publicKey: userIdentityKey } = await wallet.getPublicKey({ identityKey: true });

      // Validate updates
      if (updates.length === 0) {
        throw new Error('No updates provided');
      }

      const results: MaterialUpdateResult[] = [];

      // Get server identity key (needed for 'add' operations)
      const serverIdentityKeyResponse = await apiFetch('/api/server-identity-key');
      if (!serverIdentityKeyResponse.ok) {
        throw new Error('Failed to fetch server identity key');
      }
      const { publicKey: serverIdentityKey } = await serverIdentityKeyResponse.json();

      // Process each update
      for (const update of updates) {

        // For 'add' operations, use transfer-to-server pattern (derived-key)
        if (update.operation === 'add') {

          // Resolve the existing token's source tx (overlay → wallet-basket fallback)
          const previousTransaction = await fetchTokenSourceTx(wallet, update.currentTokenId);

          const ordinalP2PKH = new OrdinalsP2PKH();

          // Unlock existing token with its derivation (legacy fallback when absent)
          const existingDerivation = update.keyId
            ? { protocolID: TOKEN_PROTOCOL, keyID: update.keyId, counterparty: update.counterparty! }
            : undefined;
          const unlockTemplate = ordinalP2PKH.unlock(wallet, 'all', false, undefined, undefined, existingDerivation);
          const unlockingScriptLength = await unlockTemplate.estimateLength();

          // Lock the transfer output to a fresh server recipient-derived key
          const transferNonce = generateNonce();
          const serverKey = await deriveRecipientKey(wallet, serverIdentityKey, transferNonce);

          // The server rejects a transfer without the stack's mint id, and only after it broadcasts.
          if (!update.mintOutpoint) throw new Error(`${update.itemName} has no recorded mint and cannot be merged`);
          const assetId = update.mintOutpoint.replace('.', '_');
          const transferLockingScript = ordinalP2PKH.lock(
            serverKey,
            assetId,
            {
              name: 'material_token',
              lootTableId: update.lootTableId,
              itemName: update.itemName,
              description: update.description,
              icon: update.icon,
              rarity: update.rarity,
              tier: update.tier || 1,
            },
            'transfer',
            update.currentQuantity
          );

          // Step 1: Create action
          const transferActionRes = await wallet.createAction({
            description: `Transferring ${update.itemName} to server for merge`,
            inputBEEF: previousTransaction.toBEEF(),
            inputs: [{
              inputDescription: `Material token: ${update.itemName}`,
              outpoint: update.currentTokenId,
              unlockingScriptLength,
            }],
            outputs: [{
              outputDescription: `Transfer to server`,
              lockingScript: transferLockingScript.toHex(),
              satoshis: 1,
            }],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: false,
            },
          });

          if (!transferActionRes.signableTransaction) {
            throw new Error('Failed to create signable transfer transaction');
          }

          // Step 2: Sign to generate unlocking script
          const reference = transferActionRes.signableTransaction.reference;
          const txToSign = Transaction.fromBEEF(transferActionRes.signableTransaction.tx);

          txToSign.inputs[0].unlockingScriptTemplate = unlockTemplate;
          txToSign.inputs[0].sourceTransaction = previousTransaction;

          await txToSign.sign();

          const unlockingScript = txToSign.inputs[0].unlockingScript;
          if (!unlockingScript) {
            throw new Error('Missing unlocking script after signing');
          }

          // Step 3: Sign action
          const transferAction = await wallet.signAction({
            reference,
            spends: { '0': { unlockingScript: unlockingScript.toHex() } },
          });

          if (!transferAction.tx) {
            throw new Error('Failed to sign transfer action');
          }

          // Step 4: Broadcast
          const transferTx = Transaction.fromAtomicBEEF(transferAction.tx);
          const transferBroadcast = await broadcastTX(transferTx);
          const transferredToServerTokenId = `${transferBroadcast.txid}.0`;

          // Create WalletP2PKH payment for server mint + merge
          const { paymentTx, paymentTxId, walletParams } = await createWalletPayment(
            wallet,
            serverIdentityKey,
            100,
            'Payment for material add and merge'
          );

          const mergeResponse = await apiFetchStepUp('/api/materials/add-and-merge', {
            wallet,
            context: 'merge-material',
            body: {
              transferredTokenId: transferredToServerTokenId,
              transferBeef: encodeBeef(Array.from(transferAction.tx!)),
              transferNonce,
              lootTableId: update.lootTableId,
              itemName: update.itemName,
              description: update.description,
              icon: update.icon,
              rarity: update.rarity,
              tier: update.tier || 1,
              addedQuantity: update.quantity,
              currentQuantity: update.currentQuantity,
              userIdentityKey,
              paymentTx: encodeBeef(paymentTx),
              walletParams,
              reason: update.reason,
              acquiredFrom: update.acquiredFrom,
              inventoryItemIds: update.inventoryItemIds || [], // consumed server-side in the merge
            },
          });

          if (!mergeResponse.ok) {
            const errorData = await mergeResponse.json();
            throw new Error(errorData.error || 'Failed to merge materials');
          }

          const mergeData = await mergeResponse.json();

          // Internalize the merged token non-fatally (recoverable via reindexFromBasket)
          if (typeof mergeData.transferBeef === 'string' && mergeData.received) {
            try {
              await internalizeToBasket(wallet, decodeBeef(mergeData.transferBeef), [mergeData.received], `Receive ${update.itemName}`);
            } catch (e) {
              console.warn('Merged material minted server-side but wallet internalize failed (recoverable via reindexFromBasket):', e);
            }
          }

          results.push({
            lootTableId: update.lootTableId,
            itemName: update.itemName,
            previousTokenId: update.currentTokenId,
            newTokenId: mergeData.mergedTokenId,
            transactionId: mergeData.mergeTransactionId,
            previousQuantity: update.currentQuantity,
            newQuantity: mergeData.newQuantity,
            operation: 'add',
            success: true,
          });
        }
      }

      return {
        results,
        success: true,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update material tokens';
      console.error('Failed to update material tokens:', err);
      setError(errorMessage);

      return {
        results: [],
        success: false,
        error: errorMessage,
      };

    } finally {
      setIsUpdating(false);
    }
  }, []);

  return {
    updateMaterialToken,
    isUpdating,
    error,
  };
}

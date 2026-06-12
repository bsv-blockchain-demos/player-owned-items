import { useState, useCallback } from 'react';
import { WalletClient, Transaction } from '@bsv/sdk';
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';
import { createWalletPayment } from '@/utils/createWalletPayment';
import { getTransactionByTxID, broadcastTX } from './useOverlayFunctions';
import { encodeBeef, decodeBeef } from '@/utils/beefEncoding';
import { internalizeToBasket } from '@/utils/internalizeToBasket';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey } from '@/utils/tokenDerivation';

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
 * Features:
 * - Add quantity (collecting more materials)
 * - Subtract quantity (consuming for crafting)
 * - Set quantity (direct update, less common)
 * - Batch updates for multiple materials
 * - Validates sufficient quantity before consuming
 * - Same metadata structure for create and update operations
 *
 * @example
 * const { updateMaterialToken, isUpdating, error } = useUpdateMaterialToken();
 *
 * // Add materials from monster drops
 * await updateMaterialToken({
 *   wallet: connectedWallet,
 *   updates: [
 *     { lootTableId: 'iron_ore', operation: 'add', quantity: 5, ... },
 *     { lootTableId: 'coal', operation: 'add', quantity: 3, ... },
 *   ],
 * });
 *
 * // Consume materials for crafting
 * await updateMaterialToken({
 *   wallet: connectedWallet,
 *   updates: [
 *     { lootTableId: 'iron_ore', operation: 'subtract', quantity: 10, ... },
 *   ],
 * });
 */

export type MaterialUpdateOperation = 'add' | 'subtract' | 'set';

export interface MaterialTokenUpdate {
  name: string;                  // Ordinal metadata header name
  lootTableId: string;           // Material type to update
  itemName: string;              // Material name
  description: string;           // Material description (for metadata)
  icon: string;                  // Emoji icon
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  tier?: number;                 // Material tier (if applicable)
  currentTokenId: string;        // Current token ID on blockchain
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
   * Update material token quantities on the BSV blockchain
   *
   * Process:
   * 1. Validate wallet connection and authentication
   * 2. For each material update:
   *    a. Validate operation (sufficient quantity for subtract, etc.)
   *    b. Calculate new quantity based on operation
   *    c. Fetch previous transaction from overlay
   *    d. Create unlocking script with ordinalP2PKH.unlock()
   *    e. Create BSV transaction that:
   *       - References previous token (input with unlocking script)
   *       - Creates new token state with updated quantity (output) OR burns token if quantity=0
   *       - Includes update reason and timestamp
   * 3. Broadcast all transactions
   * 4. Update MaterialToken documents in database
   * 5. Return new token IDs and quantities
   *
   * Special Cases:
   * - Subtract to zero: Token burned (no output created)
   * - Invalid operations: Throw errors before broadcasting
   *
   * @param params - Update operations and wallet
   * @returns Results for each material token update
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

      console.log('Updating material tokens:', {
        updateCount: updates.length,
        operations: updates.map(u => `${u.operation} ${u.quantity} ${u.lootTableId}`),
        userIdentityKey,
      });

      // Validate updates
      if (updates.length === 0) {
        throw new Error('No updates provided');
      }

      const results: MaterialUpdateResult[] = [];

      // Get server identity key (needed for 'add' operations)
      const serverIdentityKeyResponse = await fetch('/api/server-identity-key');
      if (!serverIdentityKeyResponse.ok) {
        throw new Error('Failed to fetch server identity key');
      }
      const { publicKey: serverIdentityKey } = await serverIdentityKeyResponse.json();

      // Process each update
      for (const update of updates) {
        console.log(`Processing ${update.operation} for ${update.lootTableId}`);

        // For 'add' operations, use transfer-to-server pattern (derived-key)
        if (update.operation === 'add') {
          console.log(`[ADD] Transferring ${update.lootTableId} to server for merge`);

          // Get previous token transaction from overlay
          const previousTxid = update.currentTokenId.split('.')[0];
          const oldTx = await getTransactionByTxID(previousTxid);

          if (!oldTx || !oldTx.outputs || !oldTx.outputs[0]) {
            throw new Error(`Could not find previous transaction: ${previousTxid}`);
          }

          // Parse transaction from BEEF
          const previousTransaction = Transaction.fromBEEF(oldTx.outputs[0].beef);

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

          const assetId = update.currentTokenId.replace('.', '_');
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
            inputBEEF: oldTx.outputs[0].beef,
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

          console.log(`[ADD] Transferred to server: ${transferredToServerTokenId}`);

          // Create WalletP2PKH payment for server mint + merge
          const { paymentTx, paymentTxId, walletParams } = await createWalletPayment(
            wallet,
            serverIdentityKey,
            100,
            'Payment for material add and merge'
          );

          console.log('WalletP2PKH payment created:', { txid: paymentTxId, satoshis: 100 });

          const mergeResponse = await fetch('/api/materials/add-and-merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
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
            }),
          });

          if (!mergeResponse.ok) {
            const errorData = await mergeResponse.json();
            throw new Error(errorData.error || 'Failed to merge materials');
          }

          const mergeData = await mergeResponse.json();

          console.log(`[ADD] Server merged: ${mergeData.mergedTokenId}`);

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

          // Skip rest of loop - server handled everything
          continue;
        }

        // Calculate new quantity based on operation (for subtract/set)
        let newQuantity: number;
        switch (update.operation) {
          case 'subtract':
            newQuantity = update.currentQuantity - update.quantity;
            if (newQuantity < 0) {
              throw new Error(
                `Insufficient ${update.lootTableId}: have ${update.currentQuantity}, need ${update.quantity}`
              );
            }
            break;
          case 'set':
            newQuantity = update.quantity;
            if (newQuantity < 0) {
              throw new Error(`Invalid quantity for ${update.lootTableId}: ${newQuantity}`);
            }
            break;
          default:
            throw new Error(`Invalid operation: ${update.operation}`);
        }

        console.log(`${update.lootTableId}: ${update.currentQuantity} → ${newQuantity}`);

        // Prepare update metadata (quantity is in amt field, not metadata)
        const updateMetadata = {
          name: 'material_token',
          lootTableId: update.lootTableId,
          itemName: update.itemName,
          description: update.description,
          icon: update.icon,
          rarity: update.rarity,
          tier: update.tier || 1,
          acquiredFrom: update.acquiredFrom ? [update.acquiredFrom] : [],
        };

        console.log(`Update metadata for ${update.lootTableId}:`, updateMetadata);

        // Get previous token transaction from overlay
        const previousTxid = update.currentTokenId.split('.')[0];
        const oldTx = await getTransactionByTxID(previousTxid);

        if (!oldTx || !oldTx.outputs || !oldTx.outputs[0]) {
          throw new Error(`Could not find previous transaction: ${previousTxid}`);
        }

        // Parse transaction from BEEF
        const tx = Transaction.fromBEEF(oldTx.outputs[0].beef);

        // Create unlocking script template
        const ordinalP2PKH = new OrdinalsP2PKH();
        const template = ordinalP2PKH.unlock(wallet, "single", true);

        // Generate actual unlocking script
        const unlockingScript = await template.sign(tx, 0);

        // Outpoint string (uses period separator for createAction)
        const outpoint = `${previousTxid}.0`;

        if (newQuantity === 0) {
          // Token consumed completely - create burn transaction (no output)
          const tokenBurnAction = await wallet.createAction({
            description: "Consuming material token",
            inputBEEF: oldTx.outputs[0].beef,
            inputs: [
              {
                inputDescription: "Unlocking previous material token",
                outpoint,
                unlockingScript: unlockingScript.toHex(),
              }
            ],
            outputs: [], // No outputs = token burned
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: false,
            }
          });

          if (!tokenBurnAction.tx) {
            throw new Error('Failed to create burn transaction');
          }
          console.log('Token burn action:', tokenBurnAction);

          // Broadcast burn transaction
          const tx = Transaction.fromAtomicBEEF(tokenBurnAction.tx);
          const broadcastResponse = await broadcastTX(tx);

          console.log(`Material token burned for ${update.lootTableId}:`, {
            previousTokenId: update.currentTokenId,
            txId: broadcastResponse.txid,
          });

          results.push({
            lootTableId: update.lootTableId,
            itemName: update.itemName,
            previousTokenId: update.currentTokenId,
            newTokenId: undefined, // No new token (burned)
            transactionId: broadcastResponse.txid,
            previousQuantity: update.currentQuantity,
            newQuantity: 0,
            operation: update.operation,
            success: true,
          });
        } else {
          // Update quantity - create new token state
          // Convert to BSV-21 format (underscore separator)
          const assetId = update.currentTokenId.replace('.', '_');

          // Re-lock to the player's monsterbattle protocol key (subtract/set path)
          const { publicKey: playerPublicKey } = await wallet.getPublicKey({ protocolID: [0, 'monsterbattle'], keyID: '0' });
          const newLockingScript = ordinalP2PKH.lock(
            playerPublicKey,
            assetId,                 // Reference previous token (BSV-21 format)
            updateMetadata,
            "transfer",              // Type: transfer/update
            newQuantity              // Pass quantity as amt parameter
          );

          // Create update transaction
          const tokenUpdateAction = await wallet.createAction({
            description: "Updating material token quantity",
            inputBEEF: oldTx.outputs[0].beef,
            inputs: [
              {
                inputDescription: "Unlocking previous material token",
                outpoint,
                unlockingScript: unlockingScript.toHex(),
              }
            ],
            outputs: [
              {
                outputDescription: "Updated material token",
                lockingScript: newLockingScript.toHex(),
                satoshis: 1,
              }
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: false,
            }
          });

          if (!tokenUpdateAction.tx) {
            throw new Error('Failed to create update transaction');
          }
          console.log('Token update action:', tokenUpdateAction);

          // Broadcast transaction
          const tx = Transaction.fromAtomicBEEF(tokenUpdateAction.tx);
          const broadcastResponse = await broadcastTX(tx);

          // Extract new token ID
          const txId = broadcastResponse.txid;
          const newTokenId = `${txId}.0`;

          console.log(`Material token updated for ${update.lootTableId}:`, {
            previousTokenId: update.currentTokenId,
            newTokenId,
            previousQuantity: update.currentQuantity,
            newQuantity,
          });

          results.push({
            lootTableId: update.lootTableId,
            itemName: update.itemName,
            previousTokenId: update.currentTokenId,
            newTokenId: newTokenId,
            transactionId: txId,
            previousQuantity: update.currentQuantity,
            newQuantity: newQuantity,
            operation: update.operation,
            success: true,
          });
        }
      }

      // Call backend API to save material token updates
      const apiResult = await fetch('/api/materials/update-tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          updates: results.map((result, index) => ({
            lootTableId: updates[index].lootTableId,
            itemName: updates[index].itemName,
            previousTokenId: result.previousTokenId,
            newTokenId: result.newTokenId,
            transactionId: result.transactionId,
            previousQuantity: result.previousQuantity,
            newQuantity: result.newQuantity,
            operation: result.operation,
            inventoryItemIds: updates[index].inventoryItemIds || [],  // IDs to consume
            reason: updates[index].reason,
          })),
        }),
      });

      if (!apiResult.ok) {
        const errorData = await apiResult.json();
        throw new Error(errorData.error || 'Failed to save material token updates to database');
      }

      console.log(`Material tokens updated: ${results.length} updates`);

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

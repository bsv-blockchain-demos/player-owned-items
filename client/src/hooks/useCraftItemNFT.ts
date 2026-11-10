import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { WalletClient, Transaction, Beef } from '@bsv/sdk';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { createWalletPayment } from '@/utils/createWalletPayment';
import { encodeBeef, decodeBeef } from '@shared/beefEncoding';
import { internalizeToBasket } from '@/shared/internalizeToBasket';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey } from '@shared/tokenDerivation';
import { fetchTokenSourceTx } from '@/shared/fetchTokenSourceTx';
import type { LootItem } from '@shared/loot-table';
import { apiFetchStepUp } from '@/lib/apiFetchStepUp';

/**
 * Hook for crafting items on the BSV blockchain (derived-key pattern).
 *
 * Client batches ALL materials and artifact NFTs into ONE transfer tx (each input unlocked with its own
 * stored derivation). All transfer outputs lock to a shared server-derived key (single
 * nonce N2). Server mints crafted item, then returns crafted item + change tokens as
 * BEEF for wallet internalization.
 */

export interface CraftingInputItem {
  inventoryItemId: string;
  nftLootId?: string;
  tokenId?: string;
  mintOutpoint?: string; // BSV-21 id of the token, carried by every transfer
  transactionId?: string;
  name: string;
  rarity: string;
  type: string;
  itemType: LootItem['type'];
  lootTableId?: string;
  currentQuantity?: number;
  quantityNeeded: number;
  description?: string;
  icon?: string;
  tier?: number;
  keyId?: string;
  counterparty?: string;
}

export interface CraftItemNFTParams {
  wallet: WalletClient;
  recipeId: string;
  inputItems: CraftingInputItem[];
  // Display only — the server derives the crafted item from the recipe.
  outputItem: { name: string };
}

export interface CraftItemNFTResult {
  statRoll?: number;
  rolledStats?: Record<string, number>;
  nftId?: string;
  tokenId?: string;
  transactionId?: string;
  consumedTokenIds?: string[];
  materialChanges?: Array<{
    lootTableId: string;
    itemName: string;
    previousTokenId: string;
    newTokenId: string;
    previousQuantity: number;
    newQuantity: number;
  }>;
  success: boolean;
  error?: string;
}

const isMaterialInput = (input: CraftingInputItem) => input.itemType === 'material';

/** Inputs in batch-transfer order: material tokens, then item NFTs. Inputs without a token are dropped. */
export function craftBatch(inputItems: CraftingInputItem[]): CraftingInputItem[] {
  const tokens = inputItems.filter((input) => input.tokenId);
  return [...tokens.filter(isMaterialInput), ...tokens.filter((input) => !isMaterialInput(input))];
}

/** What the server is told: each batch output by outpoint, plus the DB doc it carries. */
export function craftTransfers(batch: CraftingInputItem[], transferTxId: string) {
  const outpoint = (input: CraftingInputItem) => `${transferTxId}.${batch.indexOf(input)}`;
  return {
    // nftLootId carries a material token's MaterialToken _id.
    transferredMaterials: batch.filter(isMaterialInput).map((input) => ({
      lootTableId: input.lootTableId!,
      tokenId: outpoint(input),
      materialTokenId: input.nftLootId!,
    })),
    transferredItems: batch.filter((input) => !isMaterialInput(input)).map((input) => ({
      lootTableId: input.lootTableId!,
      tokenId: outpoint(input),
      inventoryItemId: input.inventoryItemId,
    })),
  };
}

export function useCraftItemNFT() {
  const [isCrafting, setIsCrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const craftItemNFT = useCallback(async (
    params: CraftItemNFTParams
  ): Promise<CraftItemNFTResult> => {
    setIsCrafting(true);
    setError(null);

    try {
      const { wallet, recipeId, inputItems, outputItem } = params;

      if (!wallet) throw new Error('Wallet not connected');

      const isAuthenticated = await wallet.isAuthenticated();
      if (!isAuthenticated) throw new Error('Wallet not authenticated');

      // Identity key — derivation counterparty the server locks toward
      const { publicKey: userIdentityKey } = await wallet.getPublicKey({ identityKey: true });

      // Server identity key for payment + transfer output derivation
      const serverIdentityKeyResponse = await apiFetch('/api/server-identity-key');
      if (!serverIdentityKeyResponse.ok) throw new Error('Failed to fetch server identity key');
      const { publicKey: serverIdentityKey } = await serverIdentityKeyResponse.json();

      const { paymentTx, paymentTxId, walletParams } = await createWalletPayment(
        wallet,
        serverIdentityKey,
        100,
        'Payment for crafting fees'
      );

      // ===================================================
      // CLIENT: Batch transfer all materials and items to server
      // ===================================================

      const ordinalP2PKH = new OrdinalsP2PKH();
      const batchInputs = craftBatch(inputItems);
      // The server rejects a transfer without the token's mint id, and only after this batch broadcasts.
      const unminted = batchInputs.find((input) => !input.mintOutpoint);
      if (unminted) throw new Error(`${unminted.name} has no recorded mint and cannot be transferred`);

      // Per-input unlock: each token has its own stored derivation (legacy fallback when absent)
      const buildUnlock = (m: { keyId?: string; counterparty?: string }) =>
        ordinalP2PKH.unlock(wallet, 'all', false, undefined, undefined,
          m.keyId ? { protocolID: TOKEN_PROTOCOL, keyID: m.keyId, counterparty: m.counterparty! } : undefined);

      // All inputs share the same script length (108 bytes)
      const unlockingScriptLength = await buildUnlock(batchInputs[0]).estimateLength();

      // Resolve each input's source tx (overlay → wallet-basket fallback)
      const sourceTransactions: Transaction[] = [];
      for (const input of batchInputs) {
        sourceTransactions.push(await fetchTokenSourceTx(wallet, input.tokenId!));
      }

      // Merge BEEFs for multi-input transaction
      const mergedBeef = new Beef();
      for (const sourceTx of sourceTransactions) mergedBeef.mergeBeef(sourceTx.toBEEF());
      const inputBEEF = mergedBeef.toBinary();

      const inputs = batchInputs.map((input) => ({
        inputDescription: `${isMaterialInput(input) ? 'Material token' : 'Item'}: ${input.name}`,
        outpoint: input.tokenId!,
        unlockingScriptLength,
      }));

      // Single shared nonce N2 — all transfer outputs lock to this server-derived key
      const transferNonce = generateNonce();
      const serverKey = await deriveRecipientKey(wallet, serverIdentityKey, transferNonce);

      // Material tokens move their whole quantity; item NFTs are amount 1.
      const outputs = batchInputs.map((input) => {
        const assetId = input.mintOutpoint!.replace('.', '_');
        const lockingScript = isMaterialInput(input)
          ? ordinalP2PKH.lock(
              serverKey,
              assetId,
              {
                name: 'material_token',
                lootTableId: input.lootTableId,
                itemName: input.name,
                description: input.description,
                icon: input.icon,
                rarity: input.rarity,
                tier: input.tier || 1,
              },
              'transfer',
              input.currentQuantity
            )
          : ordinalP2PKH.lock(
              serverKey,
              assetId,
              {
                name: 'game_item',
                lootTableId: input.lootTableId, // the server checks this against the item's DB doc
                itemName: input.name,
                description: input.description,
                icon: input.icon,
                rarity: input.rarity,
                itemType: input.itemType,
                tier: input.tier || 1,
              },
              'transfer'
            );
        return { outputDescription: `Transfer ${input.name} to server`, lockingScript: lockingScript.toHex(), satoshis: 1 };
      });

      const transferActionRes = await wallet.createAction({
        description: `Transferring ${batchInputs.length} crafting inputs to server`,
        inputBEEF,
        inputs,
        outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      });

      if (!transferActionRes.signableTransaction) throw new Error('Failed to create signable batch transfer transaction');

      const reference = transferActionRes.signableTransaction.reference;
      const txToSign = Transaction.fromBEEF(transferActionRes.signableTransaction.tx);

      // Per-input unlock template using each input's own derivation
      for (let i = 0; i < batchInputs.length; i++) {
        txToSign.inputs[i].unlockingScriptTemplate = buildUnlock(batchInputs[i]);
        txToSign.inputs[i].sourceTransaction = sourceTransactions[i];
      }

      await txToSign.sign();

      const spends: Record<string, { unlockingScript: string }> = {};
      for (let i = 0; i < batchInputs.length; i++) {
        const unlockingScript = txToSign.inputs[i].unlockingScript;
        if (!unlockingScript) throw new Error(`Missing unlocking script for input ${i} (${batchInputs[i].name})`);
        spends[i.toString()] = { unlockingScript: unlockingScript.toHex() };
      }

      const transferAction = await wallet.signAction({ reference, spends });
      if (!transferAction.tx) throw new Error('Failed to sign batch transfer action');

      // Derive token IDs from the AtomicBEEF. signAction has already broadcast the batch,
      // so a server rejection from here on strands the inputs at the server key.
      const transferTx = Transaction.fromAtomicBEEF(transferAction.tx);
      const transferTxId = transferTx.id('hex');

      // The server reads quantities and metadata from each named DB doc.
      const { transferredMaterials, transferredItems } = craftTransfers(batchInputs, transferTxId);

      // ===================================================
      // SERVER: Craft item + return BEEF for internalization
      // ===================================================

      const apiResult = await apiFetchStepUp('/api/crafting/mint-and-transfer', {
        wallet,
        context: 'craft',
        body: {
          recipeId,
          transferredMaterials,
          transferredItems,
          inputItems: inputItems.map(input => ({
            inventoryItemId: input.inventoryItemId,
            tokenId: input.tokenId,
            name: input.name,
            rarity: input.rarity,
            itemType: input.itemType,
            quantityNeeded: input.quantityNeeded,
            keyId: input.keyId,
            counterparty: input.counterparty,
          })),
          userIdentityKey,
          paymentTx: encodeBeef(paymentTx),
          batchTransferBeef: encodeBeef(Array.from(transferAction.tx!)),
          transferNonce,
          walletParams,
        },
      });

      if (!apiResult.ok) {
        const errorData = await apiResult.json();
        throw new Error(errorData.error || 'Failed to craft item');
      }

      const result = await apiResult.json();

      // Internalize crafted item + change tokens (non-fatal)
      if (typeof result.transferBeef === 'string' && Array.isArray(result.received) && result.received.length) {
        try {
          await internalizeToBasket(wallet, decodeBeef(result.transferBeef), result.received, `Crafted ${outputItem.name}`);
        } catch (e) {
          console.warn('Item crafted server-side but wallet internalize failed (recoverable via reindexFromBasket):', e);
        }
      }

      return {
        nftId: result.nftId,
        tokenId: result.tokenId,
        transactionId: result.transferTransactionId,
        consumedTokenIds: [...transferredMaterials, ...transferredItems].map(m => m.tokenId),
        materialChanges: result.materialChangeTokens || [],
        statRoll: result.statRoll,
        rolledStats: result.rolledStats,
        success: true,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to craft item NFT';
      console.error('Failed to craft item NFT:', err);
      setError(errorMessage);
      return { success: false, error: errorMessage };
    } finally {
      setIsCrafting(false);
    }
  }, []);

  return { craftItemNFT, isCrafting, error };
}

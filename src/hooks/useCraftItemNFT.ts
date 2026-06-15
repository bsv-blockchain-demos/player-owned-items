import { useState, useCallback } from 'react';
import { WalletClient, Transaction, Beef } from '@bsv/sdk';
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';
import { createWalletPayment } from '@/utils/createWalletPayment';
import { encodeBeef, decodeBeef } from '@/utils/beefEncoding';
import { internalizeToBasket } from '@/utils/internalizeToBasket';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey } from '@/utils/tokenDerivation';
import { fetchTokenSourceTx } from '@/utils/fetchTokenSourceTx';

/**
 * Hook for crafting items on the BSV blockchain (derived-key pattern).
 *
 * Client batches ALL materials into ONE transfer tx (each input unlocked with its own
 * stored derivation). All transfer outputs lock to a shared server-derived key (single
 * nonce N2). Server mints crafted item, then returns crafted item + change tokens as
 * BEEF for wallet internalization.
 */

export interface CraftingInputItem {
  inventoryItemId: string;
  nftLootId?: string;
  tokenId?: string;
  transactionId?: string;
  name: string;
  rarity: string;
  type: string;
  itemType: 'weapon' | 'armor' | 'consumable' | 'material' | 'artifact';
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
  outputItem: {
    inventoryItemId: string;
    lootTableId: string;
    name: string;
    description: string;
    icon: string;
    rarity: 'common' | 'rare' | 'epic' | 'legendary';
    type: 'weapon' | 'armor' | 'consumable' | 'material' | 'artifact';
    tier?: number;
    equipmentStats?: Record<string, number>;
    crafted?: {
      statRoll: number;
      craftedBy: string;
    };
    borderGradient: {
      color1: string;
      color2: string;
    };
  };
}

export interface CraftItemNFTResult {
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
      const serverIdentityKeyResponse = await fetch('/api/server-identity-key');
      if (!serverIdentityKeyResponse.ok) throw new Error('Failed to fetch server identity key');
      const { publicKey: serverIdentityKey } = await serverIdentityKeyResponse.json();

      const { paymentTx, paymentTxId, walletParams } = await createWalletPayment(
        wallet,
        serverIdentityKey,
        100,
        'Payment for crafting fees'
      );

      console.log('WalletP2PKH payment created:', { txid: paymentTxId, satoshis: 100 });

      // ===================================================
      // CLIENT: Batch transfer all materials to server
      // ===================================================

      const ordinalP2PKH = new OrdinalsP2PKH();
      const materialInputs = inputItems.filter(input => input.tokenId && input.itemType === 'material');

      console.log(`[TRANSFER] Transferring ${materialInputs.length} materials in single batch tx`);

      // Per-input unlock: each token has its own stored derivation (legacy fallback when absent)
      const buildUnlock = (m: { keyId?: string; counterparty?: string }) =>
        ordinalP2PKH.unlock(wallet, 'all', false, undefined, undefined,
          m.keyId ? { protocolID: TOKEN_PROTOCOL, keyID: m.keyId, counterparty: m.counterparty! } : undefined);

      // All inputs share the same script length (108 bytes)
      const unlockingScriptLength = await buildUnlock(materialInputs[0]).estimateLength();

      // Resolve each material's source tx (overlay → wallet-basket fallback)
      const sourceTransactions: Transaction[] = [];
      for (const input of materialInputs) {
        sourceTransactions.push(await fetchTokenSourceTx(wallet, input.tokenId!));
      }

      // Merge BEEFs for multi-input transaction
      const mergedBeef = new Beef();
      for (const sourceTx of sourceTransactions) mergedBeef.mergeBeef(sourceTx.toBEEF());
      const inputBEEF = mergedBeef.toBinary();

      const inputs = materialInputs.map((input) => ({
        inputDescription: `Material token: ${input.name}`,
        outpoint: input.tokenId!,
        unlockingScriptLength,
      }));

      // Single shared nonce N2 — all transfer outputs lock to this server-derived key
      const transferNonce = generateNonce();
      const serverKey = await deriveRecipientKey(wallet, serverIdentityKey, transferNonce);

      const outputs = materialInputs.map((input) => {
        const assetId = input.tokenId!.replace('.', '_');
        return {
          outputDescription: `Transfer ${input.name} to server`,
          lockingScript: ordinalP2PKH.lock(
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
          ).toHex(),
          satoshis: 1,
        };
      });

      const transferActionRes = await wallet.createAction({
        description: `Transferring ${materialInputs.length} materials to server for crafting`,
        inputBEEF,
        inputs,
        outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      });

      if (!transferActionRes.signableTransaction) throw new Error('Failed to create signable batch transfer transaction');

      const reference = transferActionRes.signableTransaction.reference;
      const txToSign = Transaction.fromBEEF(transferActionRes.signableTransaction.tx);

      // Per-input unlock template using each material's own derivation
      for (let i = 0; i < materialInputs.length; i++) {
        txToSign.inputs[i].unlockingScriptTemplate = buildUnlock(materialInputs[i]);
        txToSign.inputs[i].sourceTransaction = sourceTransactions[i];
      }

      await txToSign.sign();

      const spends: Record<string, { unlockingScript: string }> = {};
      for (let i = 0; i < materialInputs.length; i++) {
        const unlockingScript = txToSign.inputs[i].unlockingScript;
        if (!unlockingScript) throw new Error(`Missing unlocking script for input ${i} (${materialInputs[i].name})`);
        spends[i.toString()] = { unlockingScript: unlockingScript.toHex() };
      }

      const transferAction = await wallet.signAction({ reference, spends });
      if (!transferAction.tx) throw new Error('Failed to sign batch transfer action');

      // Derive token IDs from the AtomicBEEF (no broadcast — server gets the full BEEF)
      const transferTx = Transaction.fromAtomicBEEF(transferAction.tx);
      const transferTxId = transferTx.id('hex');

      const transferredMaterials = materialInputs.map((input, index) => ({
        lootTableId: input.lootTableId!,
        tokenId: `${transferTxId}.${index}`,
        quantity: input.currentQuantity!,
        quantityNeeded: input.quantityNeeded,
        itemName: input.name,
        description: input.description!,
        icon: input.icon!,
        rarity: input.rarity as 'common' | 'rare' | 'epic' | 'legendary',
        tier: input.tier || 1,
      }));

      console.log('[TRANSFER] Batch transfer signed:', { txid: transferTxId, materialCount: materialInputs.length });

      // ===================================================
      // SERVER: Craft item + return BEEF for internalization
      // ===================================================

      const apiResult = await fetch('/api/crafting/mint-and-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipeId,
          transferredMaterials,
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
          outputItem: {
            inventoryItemId: outputItem.inventoryItemId,
            lootTableId: outputItem.lootTableId,
            name: outputItem.name,
            description: outputItem.description,
            icon: outputItem.icon,
            rarity: outputItem.rarity,
            type: outputItem.type,
            tier: outputItem.tier || 1,
            equipmentStats: outputItem.equipmentStats || {},
            crafted: outputItem.crafted || null,
            borderGradient: outputItem.borderGradient,
          },
          userIdentityKey,
          paymentTx: encodeBeef(paymentTx),
          batchTransferBeef: encodeBeef(Array.from(transferAction.tx!)),
          transferNonce,
          walletParams,
        }),
      });

      if (!apiResult.ok) {
        const errorData = await apiResult.json();
        throw new Error(errorData.error || 'Failed to craft item');
      }

      const result = await apiResult.json();

      console.log('Server crafted item:', { nftId: result.nftId, tokenId: result.tokenId });

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
        consumedTokenIds: transferredMaterials.map(m => m.tokenId),
        materialChanges: result.materialChangeTokens || [],
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

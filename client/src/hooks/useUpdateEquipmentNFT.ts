import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { WalletClient, Transaction, Beef } from '@bsv/sdk';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { createWalletPayment } from '@/utils/createWalletPayment';
import { encodeBeef, decodeBeef } from '@shared/beefEncoding';
import { internalizeToBasket } from '@/shared/internalizeToBasket';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey } from '@shared/tokenDerivation';
import { fetchTokenSourceTx } from '@/shared/fetchTokenSourceTx';
import { apiFetchStepUp } from '@/lib/apiFetchStepUp';

/**
 * Hook for updating equipment NFTs with inscription scrolls (derived-key pattern).
 *
 * Client transfers equipment + scrolls in a single batch tx (each input unlocked with
 * its own stored derivation). All transfer outputs lock to a shared server-derived key
 * (single nonce N2). Server applies inscriptions and returns updated equipment BEEF for
 * wallet internalization.
 */

export interface EquipmentNFTItem {
  inventoryItemId: string;
  nftLootId: string;
  tokenId: string;
  mintOutpoint?: string; // BSV-21 id of the token, carried by every transfer
  transactionId: string;
  lootTableId: string;
  name: string;
  description: string;
  icon: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  type: 'weapon' | 'armor' | 'artifact';
  tier: number;
  equipmentStats: Record<string, number>;
  crafted?: {
    statRoll: number;
    craftedBy: string;
  };
  borderGradient: {
    color1: string;
    color2: string;
  };
  prefix?: {
    type: string;
    value: number;
    name: string;
  };
  suffix?: {
    type: string;
    value: number;
    name: string;
  };
  keyId?: string;
  counterparty?: string;
}

export interface InscriptionScrollItem {
  inventoryItemId: string;
  nftLootId: string;
  tokenId: string;
  mintOutpoint?: string;
  transactionId: string;
  lootTableId: string;
  name: string;
  description: string;
  icon: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  type: 'consumable';
  inscriptionData: {
    inscriptionType: string;
    statValue: number;
    slot: 'prefix' | 'suffix';
    name: string;
    description: string;
  };
  keyId?: string;
  counterparty?: string;
}

export interface UpdateEquipmentNFTParams {
  wallet: WalletClient;
  equipmentItem: EquipmentNFTItem;
  inscriptionScrolls: InscriptionScrollItem[];
}

export interface UpdateEquipmentNFTResult {
  nftId?: string;
  tokenId?: string;
  transactionId?: string;
  previousEquipmentTokenId?: string;
  consumedScrollTokenIds?: string[];
  wasEquipped?: boolean;
  success: boolean;
  error?: string;
}

export function useUpdateEquipmentNFT() {
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateEquipmentNFT = useCallback(async (
    params: UpdateEquipmentNFTParams
  ): Promise<UpdateEquipmentNFTResult> => {
    setIsUpdating(true);
    setError(null);

    try {
      const { wallet, equipmentItem, inscriptionScrolls } = params;

      if (!wallet) throw new Error('Wallet not connected');
      if (!inscriptionScrolls || inscriptionScrolls.length === 0) throw new Error('At least one inscription scroll required');
      if (inscriptionScrolls.length > 2) throw new Error('Maximum 2 inscription scrolls allowed (prefix + suffix)');

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
        'Payment for equipment update fees'
      );

      // ===================================================
      // CLIENT: Batch transfer equipment + scrolls to server
      // ===================================================

      const ordinalP2PKH = new OrdinalsP2PKH();
      const allItems = [equipmentItem, ...inscriptionScrolls];
      // The server rejects a transfer without the token's mint id, and only after this batch broadcasts.
      const unminted = allItems.find((item) => !item.mintOutpoint);
      if (unminted) throw new Error(`${unminted.name} has no recorded mint and cannot be transferred`);

      // Per-input unlock: each token has its own stored derivation (legacy fallback when absent)
      const buildUnlock = (item: { keyId?: string; counterparty?: string }) =>
        ordinalP2PKH.unlock(wallet, 'all', false, undefined, undefined,
          item.keyId ? { protocolID: TOKEN_PROTOCOL, keyID: item.keyId, counterparty: item.counterparty! } : undefined);

      // All inputs use the same script length (108 bytes)
      const unlockingScriptLength = await buildUnlock(allItems[0]).estimateLength();

      // Resolve each item's source tx (overlay → wallet-basket fallback)
      const sourceTransactions: Transaction[] = [];
      for (const item of allItems) {
        sourceTransactions.push(await fetchTokenSourceTx(wallet, item.tokenId));
      }

      // Merge BEEFs for multi-input transaction
      const mergedBeef = new Beef();
      for (const sourceTx of sourceTransactions) mergedBeef.mergeBeef(sourceTx.toBEEF());
      const inputBEEF = mergedBeef.toBinary();

      const inputs = allItems.map((item, index) => ({
        inputDescription: index === 0 ? `Equipment: ${item.name}` : `Inscription scroll: ${item.name}`,
        outpoint: item.tokenId,
        unlockingScriptLength,
      }));

      // Single shared nonce N2 — all transfer outputs lock to this server-derived key
      const transferNonce = generateNonce();
      const serverKey = await deriveRecipientKey(wallet, serverIdentityKey, transferNonce);

      // Equipment output (index 0)
      const equipmentAssetId = equipmentItem.mintOutpoint!.replace('.', '_');
      const equipmentLockingScript = ordinalP2PKH.lock(
        serverKey,
        equipmentAssetId,
        {
          name: 'game_item',
          lootTableId: equipmentItem.lootTableId, // the server checks this against the item's DB doc
          itemName: equipmentItem.name,
          description: equipmentItem.description,
          icon: equipmentItem.icon,
          rarity: equipmentItem.rarity,
          itemType: equipmentItem.type,
          tier: equipmentItem.tier,
          stats: equipmentItem.equipmentStats,
          crafted: equipmentItem.crafted || null,
          enhancements: { prefix: equipmentItem.prefix || null, suffix: equipmentItem.suffix || null },
          visual: { borderGradient: equipmentItem.borderGradient },
        },
        'transfer'
      );

      const outputs = [{
        outputDescription: `Transfer ${equipmentItem.name} to server`,
        lockingScript: equipmentLockingScript.toHex(),
        satoshis: 1,
      }];

      // Scroll outputs (indices 1+), all locked to the same serverKey
      for (const scroll of inscriptionScrolls) {
        const scrollAssetId = scroll.mintOutpoint!.replace('.', '_');
        const scrollLockingScript = ordinalP2PKH.lock(
          serverKey,
          scrollAssetId,
          {
            name: 'inscription_scroll',
            lootTableId: scroll.lootTableId, // the server checks this against the scroll's DB doc
            itemName: scroll.name,
            description: scroll.description,
            icon: scroll.icon,
            rarity: scroll.rarity,
            inscriptionData: scroll.inscriptionData,
          },
          'transfer'
        );
        outputs.push({
          outputDescription: `Transfer ${scroll.name} to server`,
          lockingScript: scrollLockingScript.toHex(),
          satoshis: 1,
        });
      }

      const transferActionRes = await wallet.createAction({
        description: `Transferring ${equipmentItem.name} + ${inscriptionScrolls.length} scroll(s) to server for inscription`,
        inputBEEF,
        inputs,
        outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
      });

      if (!transferActionRes.signableTransaction) throw new Error('Failed to create signable batch transfer transaction');

      const reference = transferActionRes.signableTransaction.reference;
      const txToSign = Transaction.fromBEEF(transferActionRes.signableTransaction.tx);

      // Per-input unlock template using each token's own derivation
      for (let i = 0; i < allItems.length; i++) {
        txToSign.inputs[i].unlockingScriptTemplate = buildUnlock(allItems[i]);
        txToSign.inputs[i].sourceTransaction = sourceTransactions[i];
      }

      await txToSign.sign();

      const spends: Record<string, { unlockingScript: string }> = {};
      for (let i = 0; i < allItems.length; i++) {
        const unlockingScript = txToSign.inputs[i].unlockingScript;
        if (!unlockingScript) throw new Error(`Missing unlocking script for input ${i} (${allItems[i].name})`);
        spends[i.toString()] = { unlockingScript: unlockingScript.toHex() };
      }

      const transferAction = await wallet.signAction({ reference, spends });
      if (!transferAction.tx) throw new Error('Failed to sign batch transfer action');

      // Derive transferred token IDs from the AtomicBEEF. signAction has already broadcast the batch,
      // so a server rejection from here on strands the items at the server key.
      const transferTx = Transaction.fromAtomicBEEF(transferAction.tx);
      const transferTxId = transferTx.id('hex');
      const transferredEquipmentTokenId = `${transferTxId}.0`;
      const transferredScrollTokenIds = inscriptionScrolls.map((_, i) => `${transferTxId}.${i + 1}`);

      // ===================================================
      // SERVER: Update equipment
      // ===================================================

      // The server derives the item, stats and inscriptions from the owned docs + loot table.
      const apiResult = await apiFetchStepUp('/api/equipment/update', {
        wallet,
        context: 'update-equipment',
        body: {
          originalEquipmentInventoryId: equipmentItem.inventoryItemId,
          inscriptionScrollInventoryIds: inscriptionScrolls.map(s => s.inventoryItemId),
          transferredEquipmentTokenId,
          transferredScrollTokenIds,
          batchTransferBeef: encodeBeef(Array.from(transferAction.tx!)),
          transferNonce,
          userIdentityKey,
          paymentTx: encodeBeef(paymentTx),
          walletParams,
        },
      });

      if (!apiResult.ok) {
        const errorData = await apiResult.json();
        throw new Error(errorData.error || 'Failed to update equipment on server');
      }

      const result = await apiResult.json();

      // Internalize updated equipment into wallet basket (non-fatal)
      if (typeof result.transferBeef === 'string' && result.received) {
        try {
          await internalizeToBasket(wallet, decodeBeef(result.transferBeef), [result.received], `Receive ${equipmentItem.name}`);
        } catch (e) {
          console.warn('Equipment updated server-side but wallet internalize failed (recoverable via reindexFromBasket):', e);
        }
      }

      return {
        nftId: result.nftId,
        tokenId: result.tokenId,
        transactionId: result.transactionId,
        previousEquipmentTokenId: equipmentItem.tokenId,
        consumedScrollTokenIds: inscriptionScrolls.map(s => s.tokenId),
        wasEquipped: result.wasEquipped,
        success: true,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error during equipment update';
      console.error('Equipment update error:', err);
      setError(errorMessage);
      return { success: false, error: errorMessage };
    } finally {
      setIsUpdating(false);
    }
  }, []);

  return { updateEquipmentNFT, isUpdating, error };
}

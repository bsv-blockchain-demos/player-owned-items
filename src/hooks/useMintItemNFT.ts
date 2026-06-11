import { useState, useCallback } from 'react';
import { WalletClient } from '@bsv/sdk';
import { createWalletPayment } from '@/utils/createWalletPayment';
import { internalizeToBasket } from '@/utils/internalizeToBasket';
import { decodeBeef, encodeBeef } from '@/utils/beefEncoding';

/**
 * Hook for minting a dropped item as an NFT on the BSV blockchain
 *
 * This hook converts an inventory item (dropped from monsters) into a blockchain NFT.
 * Uses SERVER-SIDE minting architecture where:
 * 1. Client creates WalletP2PKH payment to server (with derivation params)
 * 2. Server wallet mints the item (single source of truth)
 * 3. Server stores mintOutpoint (proof of legitimate mint)
 * 4. Server immediately transfers to user
 * 5. Server stores transferTransactionId
 *
 * This prevents fraudulent items and simplifies SIGHASH handling.
 *
 * Payment System:
 * - Uses WalletP2PKH (not plain P2PKH) for proper derivation
 * - Client provides protocolID, keyID, and counterparty for unlocking
 * - Server can unlock using wallet parameters and source transaction
 *
 * NOTE: This hook does NOT handle material tokens. Use useCreateMaterialToken for materials.
 *
 * @example
 * const { mintItemNFT, isMinting, error } = useMintItemNFT();
 *
 * const result = await mintItemNFT({
 *   wallet: connectedWallet,
 *   itemData: inventoryItem,
 * });
 */

export interface MintItemNFTParams {
  wallet: WalletClient;
  itemData: {
    inventoryItemId: string;      // UserInventory document ID
    lootTableId: string;          // Reference to loot-table.ts
    name: string;                 // Item name (e.g., "Dragon Scale")
    description: string;          // Item description
    icon: string;                 // Emoji icon
    rarity: 'common' | 'rare' | 'epic' | 'legendary';
    type: 'weapon' | 'armor' | 'consumable' | 'artifact' | 'spell_scroll' | 'inscription_scroll';  // NO materials - use useCreateMaterialToken
    tier?: number;                // Item tier (1-5)
    equipmentStats?: Record<string, number>;  // Stats if equipment
    prefix?: string;              // Optional prefix for equipment
    suffix?: string;              // Optional suffix for equipment
    borderGradient: {             // User-specific gradient colors
      color1: string;
      color2: string;
    };
    acquiredFrom?: {              // Provenance data (from monster drop - game data only)
      monsterName: string;
      biome: string;
      tier: number;
    };
  };
}

export interface MintItemNFTResult {
  nftId?: string;              // NFT document ID (NFTLoot collection)
  tokenId?: string;            // Blockchain token identifier
  transactionId?: string;      // BSV transaction ID
  success: boolean;
  error?: string;
  internalizeWarning?: string; // Set when mint succeeded but wallet basket adoption failed (recoverable)
}

export function useMintItemNFT() {
  const [isMinting, setIsMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Mint an inventory item as an NFT on the BSV blockchain
   *
   * Server-side minting process:
   * 1. Validate wallet connection and get user's public key
   * 2. Call server API with item data and user's public key
   * 3. Server mints item (proof via mintOutpoint)
   * 4. Server immediately transfers to user
   * 5. Server creates NFTLoot document and updates UserInventory
   * 6. Return NFT ID and token ID
   *
   * @param params - Minting parameters including wallet and item data
   * @returns Result with NFT ID, token ID, and transaction IDs
   */
  const mintItemNFT = useCallback(async (
    params: MintItemNFTParams
  ): Promise<MintItemNFTResult> => {
    setIsMinting(true);
    setError(null);

    try {
      const { wallet, itemData } = params;

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

      // Fetch server identity key for payment counterparty
      const serverPubKeyResponse = await fetch('/api/server-identity-key');
      if (!serverPubKeyResponse.ok) {
        throw new Error('Failed to fetch server identity key');
      }
      const { publicKey: serverIdentityKey } = await serverPubKeyResponse.json();

      console.log('Creating WalletP2PKH payment transaction (100 sats)...');

      // Create WalletP2PKH payment with derivation params
      const { paymentTx, paymentTxId, walletParams } = await createWalletPayment(
        wallet,
        serverIdentityKey,
        100,
        'Payment for item minting fees'
      );

      console.log('WalletP2PKH payment transaction created:', {
        txid: paymentTxId,
        satoshis: 100,
        walletParams,
      });

      console.log('Requesting server-side mint for item:', {
        itemName: itemData.name,
        rarity: itemData.rarity,
        type: itemData.type,
        userIdentityKey,
        paymentTxId,
        walletParams,
      });

      // Prepare item data for server minting
      const serverMintData = {
        name: 'game_item',
        itemName: itemData.name,
        description: itemData.description,
        icon: itemData.icon,
        rarity: itemData.rarity,
        itemType: itemData.type,
        tier: itemData.tier || 1,
        stats: itemData.equipmentStats || {},
        crafted: null,  // Dropped items are not crafted
        enhancements: {
          prefix: itemData.prefix || null,
          suffix: itemData.suffix || null,
        },
        visual: {
          borderGradient: itemData.borderGradient,
        },
        acquiredFrom: itemData.acquiredFrom || null,
      };

      // Call server API for mint-and-transfer
      const apiResult = await fetch('/api/items/mint-and-transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inventoryItemId: itemData.inventoryItemId,
          itemData: serverMintData,
          userIdentityKey,
          paymentTx: encodeBeef(paymentTx),  // base64 BEEF, symmetric with server decodeBeef
          walletParams,       // Derivation params for unlocking
        }),
      });

      if (!apiResult.ok) {
        const errorData = await apiResult.json();
        throw new Error(errorData.error || 'Failed to mint and transfer item');
      }

      const result = await apiResult.json();

      console.log('Server minted and transferred item:', {
        nftId: result.nftId,
        tokenId: result.tokenId,        // Current location (after transfer)
        mintOutpoint: result.mintOutpoint, // Proof of original mint
      });

      // Record the output in the wallet basket. Non-fatal: the NFT is already
      // minted server-side, so a failure here is recoverable via reindexFromBasket.
      let internalizeWarning: string | undefined;
      if (typeof result.transferBeef === 'string' && result.received) {
        try {
          await internalizeToBasket(
            wallet,
            decodeBeef(result.transferBeef),
            [result.received],
            `Receive ${itemData.name}`,
          );
        } catch (internalizeErr) {
          internalizeWarning = internalizeErr instanceof Error ? internalizeErr.message : 'Failed to record item in wallet';
          console.warn('Item minted server-side but wallet internalize failed (recoverable via reindexFromBasket):', internalizeErr);
        }
      }

      return {
        nftId: result.nftId,
        tokenId: result.tokenId,         // Current location
        transactionId: result.tokenId?.split('.')[0], // Extract txid from outpoint
        success: true,
        internalizeWarning,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to mint item NFT';
      console.error('Failed to mint item NFT:', err);
      setError(errorMessage);

      return {
        success: false,
        error: errorMessage,
      };

    } finally {
      setIsMinting(false);
    }
  }, []);

  return {
    mintItemNFT,
    isMinting,
    error,
  };
}

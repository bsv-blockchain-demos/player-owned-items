import { useState, useCallback } from 'react';
import { WalletClient } from '@bsv/sdk';
import { createWalletPayment } from '@/utils/createWalletPayment';
import { internalizeToBasket } from '@/utils/internalizeToBasket';
import { encodeBeef, decodeBeef } from '@/utils/beefEncoding';

/**
 * Hook for creating material tokens on the BSV blockchain.
 * Single-tx mint: server mints directly to user's recipient-derived key.
 * Client internalizes the returned BEEF into its wallet basket (non-fatal).
 */

export interface MaterialTokenData {
  name: string;                 // Ordinal metadata header name
  lootTableId: string;          // Reference to loot-table.ts (e.g., "iron_ore")
  itemName: string;             // Material name
  description: string;          // Material description
  icon: string;                 // Emoji icon
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  tier?: number;                // Material tier (if applicable)
  quantity: number;             // Initial quantity
  inventoryItemIds?: string[];  // UserInventory IDs to consume after minting
  acquiredFrom?: Array<{        // Optional: Track where materials came from (game data only)
    monsterName: string;
    biome: string;
    quantity: number;           // How many from this source
  }>;
}

export interface CreateMaterialTokenParams {
  wallet: WalletClient;
  materials: MaterialTokenData[]; // Must be length 1
}

export interface MaterialTokenResult {
  lootTableId: string;
  tokenId?: string;              // Blockchain token ID
  transactionId?: string;        // BSV transaction ID
  quantity: number;
  success: boolean;
  error?: string;
}

export interface CreateMaterialTokenResult {
  results: MaterialTokenResult[];
  success: boolean;
  error?: string;
  internalizeWarning?: string; // Set when mint succeeded but wallet basket adoption failed (recoverable)
}

export function useCreateMaterialToken() {
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMaterialToken = useCallback(async (
    params: CreateMaterialTokenParams
  ): Promise<CreateMaterialTokenResult> => {
    setIsCreating(true);
    setError(null);

    try {
      const { wallet, materials } = params;

      // Validate inputs before doing any wallet work / charging the user.
      if (materials.length !== 1) {
        throw new Error('Only one material token can be minted at a time');
      }
      if (materials[0].quantity <= 0) {
        throw new Error(`Invalid quantity for ${materials[0].itemName}: ${materials[0].quantity}`);
      }

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
        'Payment for material minting fees'
      );

      console.log('WalletP2PKH payment transaction created:', {
        txid: paymentTxId,
        satoshis: 100,
        walletParams,
      });

      console.log('Requesting server-side mint for materials:', {
        materialCount: materials.length,
        materials: materials.map(m => `${m.itemName} x${m.quantity}`),
        userIdentityKey,
        paymentTxId,
        walletParams,
      });

      // Call server API for mint-and-transfer
      const apiResult = await fetch('/api/materials/mint-and-transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          materials: materials.map(material => ({
            lootTableId: material.lootTableId,
            itemName: material.itemName,
            description: material.description,
            icon: material.icon,
            rarity: material.rarity,
            tier: material.tier || 1,
            quantity: material.quantity,
            inventoryItemIds: material.inventoryItemIds || [],
            acquiredFrom: material.acquiredFrom || [],
          })),
          userIdentityKey,
          paymentTx: encodeBeef(paymentTx),  // base64 BEEF, symmetric with server decodeBeef
          walletParams,
        }),
      });

      if (!apiResult.ok) {
        const errorData = await apiResult.json();

        // 409 Conflict means token already exists — caller should use add-and-merge
        if (apiResult.status === 409 && errorData.shouldUseAddAndMerge) {
          console.warn('Token already exists, should use add-and-merge route:', errorData);
          throw new Error('SWITCH_TO_ADD_AND_MERGE');
        }

        throw new Error(errorData.error || 'Failed to mint and transfer materials');
      }

      const response = await apiResult.json();

      console.log('Server minted and transferred materials:', response.results);

      // Internalize the minted output into the wallet basket. Non-fatal: the token
      // is already minted server-side, so a failure here is recoverable via reindexFromBasket.
      let internalizeWarning: string | undefined;
      if (typeof response.transferBeef === 'string' && response.received) {
        try {
          await internalizeToBasket(
            wallet,
            decodeBeef(response.transferBeef),
            [response.received],
            `Receive ${materials[0].itemName}`,
          );
        } catch (e) {
          internalizeWarning = e instanceof Error ? e.message : 'Failed to record material in wallet';
          console.warn('Material minted server-side but wallet internalize failed (recoverable via reindexFromBasket):', e);
        }
      }

      // Transform server response to match expected format
      const results: MaterialTokenResult[] = response.results.map((result: any) => ({
        lootTableId: result.lootTableId,
        tokenId: result.tokenId,
        transactionId: result.transactionId,
        quantity: result.quantity,
        success: true,
      }));

      return {
        results,
        success: true,
        internalizeWarning,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create material tokens';
      console.error('Failed to create material tokens:', err);
      setError(errorMessage);

      return {
        results: [],
        success: false,
        error: errorMessage,
      };

    } finally {
      setIsCreating(false);
    }
  }, []);

  return {
    createMaterialToken,
    isCreating,
    error,
  };
}

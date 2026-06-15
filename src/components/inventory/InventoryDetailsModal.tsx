'use client';

import React, { useState, useEffect } from 'react';
import { LootItem } from '@/lib/loot-table';
import toast from 'react-hot-toast';
import { tierToRoman } from '@/utils/tierUtils';
import StatRangeIndicator from '@/components/crafting/StatRangeIndicator';
import { getInscribedItemName } from '@/utils/itemNameHelpers';
import type { Inscription } from '@/lib/types';
import { useMintItemNFT } from '@/hooks/useMintItemNFT';
import { useCreateMaterialToken } from '@/hooks/useCreateMaterialToken';
import { useUpdateMaterialToken } from '@/hooks/useUpdateMaterialToken';
import { useAuthContext } from '@/contexts/WalletContext';
import MaterialMintModal from './MaterialMintModal';

interface InventoryDetailsModalProps {
  item: LootItem & {
    acquiredAt: Date;
    inventoryId: string;
    nftLootId?: string;
    mintTransactionId?: string; // Derived from mintOutpoint (original mint txid)
    mintOutpoint?: string;      // Original server mint proof (txid.vout)
    tokenId?: string;           // Current location (txid.vout)
    isMinted: boolean;
    borderGradient?: { color1: string; color2: string }; // User-specific gradient
    count?: number; // Number of items in stack (if stacked)
    items?: any[]; // All individual items in the stack (if stacked)
    tier: number; // Item tier (1-5)
    crafted?: boolean; // Whether item was crafted
    statRoll?: number; // Stat roll for crafted items
    isEmpowered?: boolean; // Whether item was dropped by corrupted monster
    prefix?: Inscription; // Prefix inscription
    suffix?: Inscription; // Suffix inscription
    enhanced?: boolean; // Phase 3.5: Enhanced consumable (infinite uses)
  };
  onClose: () => void;
  onMintSuccess?: () => void; // Callback to refresh inventory after minting
  onStartMinting?: (inventoryId: string) => void; // Callback when minting starts (optimistic UI)
  onMintComplete?: (inventoryId: string) => void; // Callback when minting completes
}

export default function InventoryDetailsModal({ item, onClose, onMintSuccess, onStartMinting, onMintComplete }: InventoryDetailsModalProps) {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  const [showMaterialModal, setShowMaterialModal] = useState(false);
  const [isMintingMaterial, setIsMintingMaterial] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [showRefineConfirm, setShowRefineConfirm] = useState(false);
  const [refineStoneCount, setRefineStoneCount] = useState(0);

  // Blockchain minting hooks and wallet context
  const { mintItemNFT, isMinting, error: mintError } = useMintItemNFT();
  const { createMaterialToken, isCreating } = useCreateMaterialToken();
  const { updateMaterialToken, isUpdating } = useUpdateMaterialToken();
  const { userWallet, isAuthenticated, initializeWallet } = useAuthContext();

  // Prevent body scroll when modal is open
  useEffect(() => {
    // Save original overflow style
    const originalOverflow = document.body.style.overflow;
    // Disable body scroll
    document.body.style.overflow = 'hidden';

    // Restore original overflow on cleanup
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  // Detect if this is a material item
  const isMaterial = item.type === 'material';

  // Detect if item can be minted
  // Regular consumables CANNOT be minted (only enhanced ones can)
  // Spells CAN be minted (they're not single-use)
  const canMint =
    item.type === 'weapon' ||
    item.type === 'armor' ||
    item.type === 'artifact' ||
    item.type === 'spell_scroll' ||
    item.type === 'inscription_scroll' ||
    (item.type === 'consumable' && item.enhanced); // Only enhanced consumables

  const isBlockedConsumable = item.type === 'consumable' && !item.enhanced;

  // Fetch refine stone count on mount (for crafted equipment)
  const isRefinable = item.crafted && item.statRoll !== undefined &&
    (item.type === 'weapon' || item.type === 'armor' || item.type === 'artifact');

  useEffect(() => {
    if (isRefinable) {
      // Only fetch minted materials (refine stones must be minted to use)
      fetch('/api/inventory/get?mintedOnly=true')
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            const refineStones = data.inventory.filter((invItem: any) => invItem.lootTableId === 'refine_stone');
            setRefineStoneCount(refineStones.length);
          }
        })
        .catch(err => console.error('Failed to fetch refine stone count:', err));
    }
  }, [isRefinable]);

  const rarityColors = {
    common: 'text-gray-400 border-gray-400',
    rare: 'text-blue-400 border-blue-400',
    epic: 'text-purple-400 border-purple-400',
    legendary: 'text-amber-400 border-amber-400'
  };

  const handleConnectWallet = async () => {
    setIsConnectingWallet(true);
    try {
      await initializeWallet();
    } catch (error) {
      console.error('Wallet connection error:', error);
    } finally {
      setIsConnectingWallet(false);
    }
  };

  const handleMaterialMint = async (quantity: number) => {
    try {
      // Check wallet connection BEFORE starting optimistic update
      if (!userWallet) {
        toast.error('Wallet not connected. Please connect your BSV wallet first.');
        return;
      }

      if (!isAuthenticated) {
        toast.error('Wallet not authenticated. Please authenticate your wallet.');
        return;
      }

      // Mark as minting (optimistic UI update)
      if (onStartMinting) {
        onStartMinting(item.inventoryId);
      }

      // Show toast and close modals immediately
      const mintingToast = toast.loading('Minting material token in background...');
      setShowMaterialModal(false);
      onClose();
      setIsMintingMaterial(true);

      // Check if this material+tier already has a token
      const checkResponse = await fetch('/api/materials/check-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lootTableId: item.lootId,
          tier: item.tier || 1,
        }),
      });

      const checkData = await checkResponse.json();
      const existingToken = checkData.exists ? checkData.token : null;

      console.log('[MATERIAL-MINT] Check token result:', {
        lootTableId: item.lootId,
        tier: item.tier || 1,
        exists: checkData.exists,
        existingToken,
      });

      if (existingToken) {
        // Token exists - update quantity (use add-and-merge route for on-chain merging)
        toast.loading('Merging material tokens on-chain...', { id: mintingToast });

        // Calculate which inventory items to consume (first N items from the stack)
        const inventoryItemIds = item.items
          ? item.items.slice(0, quantity).map((i: any) => i.inventoryId)
          : [item.inventoryId];

        const updateResult = await updateMaterialToken({
          wallet: userWallet,
          updates: [{
            name: 'material_token',
            lootTableId: item.lootId,
            itemName: item.name,
            description: item.description,
            icon: item.icon,
            rarity: item.rarity,
            tier: item.tier || 1,
            currentTokenId: existingToken.tokenId,
            currentQuantity: existingToken.quantity,
            keyId: existingToken.keyId,
            counterparty: existingToken.counterparty,
            operation: 'add',
            quantity: quantity,
            inventoryItemIds: inventoryItemIds,  // Pass IDs to consume
            reason: 'Minting additional materials from inventory',
          }],
        });

        if (!updateResult.success || !updateResult.results[0]?.success) {
          throw new Error(updateResult.error || updateResult.results[0]?.error || 'Failed to update material token');
        }

        toast.success(`Token updated! Added ${quantity} to ${item.name}`, {
          id: mintingToast,
          duration: 5000
        });

      } else {
        // Token doesn't exist - create new
        toast.loading('Creating new material token...', { id: mintingToast });

        // Calculate which inventory items to consume (first N items from the stack)
        const inventoryItemIds = item.items
          ? item.items.slice(0, quantity).map((i: any) => i.inventoryId)
          : [item.inventoryId];

        try {
          const createResult = await createMaterialToken({
            wallet: userWallet,
            materials: [{
              name: 'material_token',
              lootTableId: item.lootId,
              itemName: item.name,
              description: item.description,
              icon: item.icon,
              rarity: item.rarity,
              tier: item.tier || 1,
              quantity: quantity,
              inventoryItemIds: inventoryItemIds,  // Pass IDs to consume
            }],
          });

          if (!createResult.success || !createResult.results[0]?.success) {
            const error = createResult.error || createResult.results[0]?.error || 'Failed to create material token';

            // Check if we need to switch to add-and-merge route
            if (error === 'SWITCH_TO_ADD_AND_MERGE') {
              console.log('[MATERIAL-MINT] Token was created by another session, switching to add-and-merge...');

              // Re-check for existing token
              const recheckResponse = await fetch('/api/materials/check-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  lootTableId: item.lootId,
                  tier: item.tier || 1,
                }),
              });

              const recheckData = await recheckResponse.json();
              const recheckToken = recheckData.exists ? recheckData.token : null;

              if (!recheckToken) {
                throw new Error('Token still not found after conflict, please try again');
              }

              // Use add-and-merge route instead
              toast.loading('Merging with existing token...', { id: mintingToast });

              const updateResult = await updateMaterialToken({
                wallet: userWallet,
                updates: [{
                  name: 'material_token',
                  lootTableId: item.lootId,
                  itemName: item.name,
                  description: item.description,
                  icon: item.icon,
                  rarity: item.rarity,
                  tier: item.tier || 1,
                  currentTokenId: recheckToken.tokenId,
                  currentQuantity: recheckToken.quantity,
                  keyId: recheckToken.keyId,
                  counterparty: recheckToken.counterparty,
                  operation: 'add',
                  quantity: quantity,
                  inventoryItemIds: inventoryItemIds,
                  reason: 'Minting additional materials from inventory',
                }],
              });

              if (!updateResult.success || !updateResult.results[0]?.success) {
                throw new Error(updateResult.error || updateResult.results[0]?.error || 'Failed to merge material token');
              }

              toast.success(`Token merged! Added ${quantity} to ${item.name}`, {
                id: mintingToast,
                duration: 5000
              });
            } else {
              throw new Error(error);
            }
          } else {
            toast.success(`Material token created! Minted ${quantity}x ${item.name}`, {
              id: mintingToast,
              duration: 5000
            });
          }
        } catch (createError) {
          // Re-throw to be caught by outer catch block
          throw createError;
        }
      }

      // Refresh inventory to show minted status
      if (onMintSuccess) {
        onMintSuccess();
      }

      // Mark as minted (removes from minting set)
      if (onMintComplete) {
        onMintComplete(item.inventoryId);
      }

    } catch (error) {
      console.error('Material minting error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to mint material token');

      // Remove from minting state on error
      if (onMintComplete) {
        onMintComplete(item.inventoryId);
      }
    } finally {
      setIsMintingMaterial(false);
    }
  };

  const handleMintNFT = async () => {
    try {
      // Check wallet connection BEFORE starting optimistic update
      if (!userWallet) {
        toast.error('Wallet not connected. Please connect your BSV wallet first.');
        return;
      }

      if (!isAuthenticated) {
        toast.error('Wallet not authenticated. Please authenticate your wallet.');
        return;
      }

      // Mark as minting (optimistic UI update)
      if (onStartMinting) {
        onStartMinting(item.inventoryId);
      }

      // Show toast and close modal immediately
      const mintingToast = toast.loading('Minting NFT in background...');
      onClose();

      // Prepare item data for blockchain minting
      const itemData = {
        inventoryItemId: item.inventoryId,
        lootTableId: item.lootId,
        name: item.name,
        description: item.description,
        icon: item.icon,
        rarity: item.rarity,
        type: item.type as 'weapon' | 'armor' | 'consumable' | 'artifact' | 'spell_scroll' | 'inscription_scroll', // Exclude material type
        tier: item.tier || 1,
        equipmentStats: item.equipmentStats ? { ...item.equipmentStats } as Record<string, number> : undefined,
        prefix: item.prefix?.name,
        suffix: item.suffix?.name,
        borderGradient: item.borderGradient || { color1: '#ffffff', color2: '#cccccc' },
        acquiredFrom: undefined, // TODO: Add provenance data if available in the future
      };

      toast.loading('Creating blockchain transaction...', { id: mintingToast });

      // Call the blockchain minting hook (continues in background)
      const result = await mintItemNFT({
        wallet: userWallet,
        itemData,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to mint NFT');
      }

      toast.success(`NFT minted! TX: ${result.transactionId?.slice(0, 8)}...`, {
        id: mintingToast,
        duration: 5000
      });

      // Refresh inventory to show minted status
      if (onMintSuccess) {
        onMintSuccess();
      }

      // Mark as minted (removes from minting set)
      if (onMintComplete) {
        onMintComplete(item.inventoryId);
      }

    } catch (error) {
      console.error('Minting error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to mint NFT');

      // Remove from minting state on error
      if (onMintComplete) {
        onMintComplete(item.inventoryId);
      }
    }
  };

  // Phase 3.5: Handle consumable enhancement
  const handleEnhanceConsumable = async () => {
    setIsEnhancing(true);
    const enhancingToast = toast.loading('Enhancing consumable...');

    try {
      const response = await fetch('/api/consumables/enhance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetItemId: item.inventoryId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to enhance consumable');
      }

      toast.success(`${data.itemName} enhanced! It now has infinite uses with cooldown.`, { id: enhancingToast, duration: 4000 });

      // Call the callback to refresh inventory
      if (onMintSuccess) {
        onMintSuccess();
      }

      // Close modal after successful enhancement
      setTimeout(() => {
        onClose();
      }, 1500);

    } catch (error) {
      console.error('Enhancement error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to enhance consumable', { id: enhancingToast });
    } finally {
      setIsEnhancing(false);
    }
  };

  // Calculate enhancement cost based on rarity
  const getEnhancementCost = (rarity: string): number => {
    const costs: Record<string, number> = {
      common: 500,
      rare: 2000,
      epic: 5000,
      legendary: 10000
    };
    return costs[rarity] || 500;
  };

  // Handle refine stone usage
  const handleRefine = async () => {
    setShowRefineConfirm(false);
    setIsRefining(true);
    const refiningToast = toast.loading('Refining equipment...');

    try {
      // Get first refine stone from inventory (must be minted to use)
      const inventoryRes = await fetch('/api/inventory/get?mintedOnly=true');
      const inventoryData = await inventoryRes.json();

      if (!inventoryData.success) {
        throw new Error('Failed to fetch inventory');
      }

      const refineStone = inventoryData.inventory.find((invItem: any) => invItem.lootTableId === 'refine_stone');
      if (!refineStone) {
        throw new Error('No refine stone found in inventory');
      }

      const response = await fetch('/api/crafting/refine', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetItemId: item.inventoryId,
          refineStoneId: refineStone._id,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to refine item');
      }

      const oldPercent = Math.round((data.oldStatRoll - 0.8) / 0.4 * 100);
      const rolledPercent = Math.round((data.rolledStatRoll - 0.8) / 0.4 * 100);
      const finalPercent = Math.round((data.finalStatRoll - 0.8) / 0.4 * 100);

      if (data.wasUpgraded) {
        toast.success(
          `${data.targetItem.name} refined! ${oldPercent}% → ${finalPercent}% quality`,
          { id: refiningToast, duration: 5000 }
        );
      } else {
        toast.success(
          `${data.targetItem.name} refined! Rolled ${rolledPercent}%, kept ${finalPercent}% (no downgrade)`,
          { id: refiningToast, duration: 5000 }
        );
      }

      // Update refine stone count
      setRefineStoneCount(prev => prev - 1);

      // Call the callback to refresh inventory
      if (onMintSuccess) {
        onMintSuccess();
      }

      // Close modal after successful refinement
      setTimeout(() => {
        onClose();
      }, 1500);

    } catch (error) {
      console.error('Refinement error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to refine item', { id: refiningToast });
    } finally {
      setIsRefining(false);
    }
  };

  const typeLabels = {
    weapon: 'Weapon',
    armor: 'Armor',
    consumable: 'Consumable',
    material: 'Material',
    artifact: 'Artifact',
    spell_scroll: 'Spell Scroll',
    inscription_scroll: 'Inscription Scroll'
  };

  // Use custom gradient border if available
  const modalBorderStyle = item.borderGradient ? {
    borderImage: `linear-gradient(135deg, ${item.borderGradient.color1}, ${item.borderGradient.color2}) 1`,
    boxShadow: `0 0 30px ${item.borderGradient.color1}60, 0 0 30px ${item.borderGradient.color2}60, 0 20px 25px -5px rgba(0, 0, 0, 0.3)` // Gradient glow + shadow
  } : {};

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div
        className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-lg border-2 border-amber-600 max-w-md w-full p-6 shadow-2xl relative"
        style={modalBorderStyle}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors cursor-pointer z-10"
          aria-label="Close modal"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Scrollable content container */}
        <div className="max-h-[calc(90vh-8rem)] overflow-y-auto pr-2">
          {/* Item icon and name */}
          <div className="text-center mb-6">
            <div className="text-7xl mb-3">{item.icon}</div>
            <h2 className={`text-2xl font-bold ${rarityColors[item.rarity].split(' ')[0]}`}>
              {getInscribedItemName(item.name, item.prefix, item.suffix)}
            </h2>
            {item.count && item.count > 1 && (
              <div className="mt-2 inline-block bg-gray-800 border-2 border-white text-white text-sm font-bold px-3 py-1 rounded-full">
                You have {item.count} of these
              </div>
            )}
          </div>

          {/* Metadata grid */}
          <div className="space-y-4">
          {/* Rarity */}
          <div className="flex justify-between items-center pb-3 border-b border-gray-700">
            <span className="text-gray-400 text-sm font-medium">Rarity</span>
            <span className={`font-bold uppercase text-sm ${rarityColors[item.rarity].split(' ')[0]}`}>
              {item.rarity}
            </span>
          </div>

          {/* Type */}
          <div className="flex justify-between items-center pb-3 border-b border-gray-700">
            <span className="text-gray-400 text-sm font-medium">Type</span>
            <span className="text-white font-medium">{typeLabels[item.type]}</span>
          </div>

          {/* Tier */}
          <div className="flex justify-between items-center pb-3 border-b border-gray-700">
            <span className="text-gray-400 text-sm font-medium">Tier</span>
            <div className="flex items-center gap-2">
              <span className="text-white font-bold">{tierToRoman(item.tier || 1)}</span>
              <span className="text-gray-500 text-xs">({item.tier || 1})</span>
            </div>
          </div>

          {/* Phase 3.5: Consumable Enhancement Section */}
          {item.type === 'consumable' && (
            <div className="pb-3 border-b border-gray-700">
              <span className="text-gray-400 text-sm font-medium block mb-2">Enhancement</span>

              {item.enhanced ? (
                // Already enhanced
                <div className="bg-cyan-900/30 border-2 border-cyan-500/50 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-cyan-400 text-lg">✨</span>
                    <span className="text-cyan-300 font-bold text-sm">Enhanced Consumable</span>
                  </div>
                  <div className="text-cyan-200 text-xs leading-relaxed">
                    This consumable has <span className="font-bold text-cyan-300">infinite uses</span>. Cooldown still applies.
                  </div>
                </div>
              ) : (
                // Can be enhanced
                <div className="space-y-3">
                  <div className="bg-gray-800/50 border border-gray-600 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-lg">💎</span>
                      <span className="text-gray-300 font-medium text-sm">Not Enhanced</span>
                    </div>
                    <div className="text-gray-400 text-xs leading-relaxed">
                      Enhance this consumable to make it <span className="font-bold text-white">infinite-use</span> (with cooldown).
                    </div>
                    <div className="text-gray-400 text-xs">
                      <div>💰 Cost: <span className="text-yellow-400 font-bold">{getEnhancementCost(item.rarity)} gold</span></div>
                      <div>📦 Required: <span className="text-white font-bold">5 copies</span> of this consumable</div>
                      <div className="mt-1">📊 You have: <span className="text-white font-bold">{item.count || 1} copies</span></div>
                    </div>
                  </div>

                  {(item.count || 1) >= 5 ? (
                    <button
                      onClick={handleEnhanceConsumable}
                      disabled={isEnhancing}
                      className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 text-white font-bold py-3 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
                    >
                      {isEnhancing ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          <span>Enhancing...</span>
                        </>
                      ) : (
                        <>
                          <span>✨</span>
                          <span>Enhance Consumable</span>
                          <span className="text-sm opacity-80">({getEnhancementCost(item.rarity)}g)</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-3">
                      <div className="text-red-400 text-xs text-center">
                        Need {5 - (item.count || 1)} more copies to enhance
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Empowered Status */}
          {item.isEmpowered && (
            <div className="pb-3 border-b border-gray-700">
              <span className="text-gray-400 text-sm font-medium block mb-2">Empowered Item</span>
              <div className="bg-purple-900/30 border-2 border-purple-500/50 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-purple-400 text-lg">⚡</span>
                  <span className="text-purple-300 font-bold text-sm">Corrupted Monster Drop</span>
                </div>
                <div className="text-purple-200 text-xs leading-relaxed">
                  This item was dropped by a corrupted monster and grants <span className="font-bold text-purple-300">+20% bonus stats</span> if it has equipment stats.
                </div>
              </div>
            </div>
          )}

          {/* Crafted Status & Stat Roll */}
          {item.crafted && (
            <div className="pb-3 border-b border-gray-700">
              <span className="text-gray-400 text-sm font-medium block mb-2">Crafted Item</span>
              <div className="bg-purple-900/20 border border-purple-500/30 rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-purple-400 text-lg">🔨</span>
                  <span className="text-purple-300 font-medium text-sm">Player Crafted</span>
                </div>
                {item.statRoll && (
                  <div className="space-y-2">
                    <div className="text-xs text-gray-400">
                      Stat Quality:
                    </div>
                    <StatRangeIndicator statRoll={item.statRoll} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Refine System (for crafted equipment) */}
          {isRefinable && (
            <div className="pb-3 border-b border-gray-700">
              <span className="text-gray-400 text-sm font-medium block mb-2">Refine Equipment</span>

              <div className="space-y-3">
                <div className="bg-gray-800/50 border border-gray-600 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 text-lg">💎</span>
                    <span className="text-gray-300 font-medium text-sm">Stat Refinement</span>
                  </div>
                  <div className="text-gray-400 text-xs leading-relaxed">
                    Use a <span className="font-bold text-white">Refine Stone</span> to reroll this item's stat variance. Guarantees a minimum of <span className="font-bold text-green-400">+1% quality boost</span> per use.
                  </div>
                  <div className="text-gray-400 text-xs">
                    <div>💎 Available: <span className="text-white font-bold">{refineStoneCount} Refine Stones</span></div>
                  </div>
                </div>

                {refineStoneCount > 0 ? (
                  <button
                    onClick={() => setShowRefineConfirm(true)}
                    disabled={isRefining}
                    className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold py-3 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
                  >
                    {isRefining ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Refining...</span>
                      </>
                    ) : (
                      <>
                        <span>💎</span>
                        <span>Refine Equipment</span>
                      </>
                    )}
                  </button>
                ) : (
                  <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-3">
                    <div className="text-red-400 text-xs text-center">
                      No Refine Stones available. Craft them in the Crafting menu.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Description */}
          <div className="pb-3 border-b border-gray-700">
            <span className="text-gray-400 text-sm font-medium block mb-2">Description</span>
            <p className="text-white text-sm leading-relaxed">{item.description}</p>
          </div>

          {/* Equipment Stats */}
          {item.equipmentStats && (
            <div className="pb-3 border-b border-gray-700">
              <span className="text-gray-400 text-sm font-medium block mb-2">Equipment Stats</span>
              <div className="bg-gray-800/50 rounded-lg p-3 space-y-1">
                {item.equipmentStats.damageBonus !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Damage Bonus:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.damageBonus}</span>
                  </div>
                )}
                {item.equipmentStats.critChance !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Crit Chance:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.critChance}%</span>
                  </div>
                )}
                {item.equipmentStats.defense !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Defense:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.defense}</span>
                  </div>
                )}
                {item.equipmentStats.maxHpBonus !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Max HP Bonus:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.maxHpBonus}</span>
                  </div>
                )}
                {item.equipmentStats.attackSpeed !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Attack Speed:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.attackSpeed}</span>
                  </div>
                )}
                {item.equipmentStats.coinBonus !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Coin Bonus:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.coinBonus}%</span>
                  </div>
                )}
                {item.equipmentStats.healBonus !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Heal Bonus:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.healBonus}%</span>
                  </div>
                )}
                {item.equipmentStats.lifesteal !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Lifesteal (Offense):</span>
                    <span className="text-red-400 font-bold">+{item.equipmentStats.lifesteal}%</span>
                  </div>
                )}
                {item.equipmentStats.defensiveLifesteal !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Tank Heal (Defense):</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.defensiveLifesteal}%</span>
                  </div>
                )}
                {item.equipmentStats.thorns !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Thorns (Reflect):</span>
                    <span className="text-orange-400 font-bold">+{item.equipmentStats.thorns}%</span>
                  </div>
                )}
                {item.equipmentStats.autoClickRate !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Auto-Click Rate:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.autoClickRate}/sec</span>
                  </div>
                )}
                {item.equipmentStats.fireResistance !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Fire Resistance:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.fireResistance}%</span>
                  </div>
                )}
                {item.equipmentStats.poisonResistance !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Poison Resistance:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.poisonResistance}%</span>
                  </div>
                )}
                {item.equipmentStats.bleedResistance !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-300">Bleed Resistance:</span>
                    <span className="text-green-400 font-bold">+{item.equipmentStats.bleedResistance}%</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* NFT Status */}
          <div className="pb-3 border-b border-gray-700">
            <span className="text-gray-400 text-sm font-medium block mb-2">NFT Status</span>
            {!item.isMinted ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 bg-gray-500/10 border border-gray-500/30 rounded-lg p-3">
                  <span className="text-gray-400 text-lg">📋</span>
                  <div>
                    <div className="text-gray-300 font-medium text-sm">Not Minted Yet</div>
                    <div className="text-gray-400 text-xs mt-1">
                      Mint this item as an NFT to preserve it on the blockchain
                    </div>
                  </div>
                </div>

                {/* Wallet Connection Status */}
                {!userWallet || !isAuthenticated ? (
                  <div className="bg-amber-900/20 border border-amber-500/30 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-amber-400 text-lg">⚠️</span>
                      <span className="text-amber-300 font-medium text-sm">Wallet Not Connected</span>
                    </div>
                    <div className="text-amber-200 text-xs mb-3">
                      You need to connect your BSV wallet to mint items as NFTs. The wallet will be used to sign the blockchain transaction.
                    </div>
                    <button
                      onClick={handleConnectWallet}
                      disabled={isConnectingWallet}
                      className={`w-full text-white text-sm font-medium py-2 px-4 rounded transition-all duration-200 cursor-pointer flex items-center justify-center gap-2 ${
                        isConnectingWallet
                          ? 'bg-amber-800 cursor-not-allowed'
                          : 'bg-amber-600 hover:bg-amber-700'
                      }`}
                    >
                      {isConnectingWallet ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          <span>Connecting...</span>
                        </>
                      ) : (
                        'Connect Wallet'
                      )}
                    </button>
                  </div>
                ) : null}

                <button
                  onClick={isMaterial ? () => setShowMaterialModal(true) : handleMintNFT}
                  disabled={isMinting || !userWallet || !isAuthenticated || isBlockedConsumable}
                  className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white font-bold py-3 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
                >
                  {isMinting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Minting on Blockchain...</span>
                    </>
                  ) : !userWallet || !isAuthenticated ? (
                    <>
                      <span>🔒</span>
                      <span>Connect Wallet to Mint</span>
                    </>
                  ) : isBlockedConsumable ? (
                    <>
                      <span>⚠️</span>
                      <span>Enhance to Mint (5 copies required)</span>
                    </>
                  ) : isMaterial ? (
                    <>
                      <span>💎</span>
                      <span>Mint Material Token</span>
                      <span className="text-sm opacity-80">(costs BSV)</span>
                    </>
                  ) : (
                    <>
                      <span>💎</span>
                      <span>Mint as NFT</span>
                      <span className="text-sm opacity-80">(costs BSV)</span>
                    </>
                  )}
                </button>
              </div>
            ) : item.mintTransactionId ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-green-400 text-lg">✓</span>
                  <span className="text-green-400 font-medium text-sm">Minted on Blockchain</span>
                </div>

                {/* Original Mint Info */}
                <div className="space-y-1">
                  <div className="text-xs text-gray-400 font-medium">Original Mint</div>
                  <div className="text-xs text-gray-500 font-mono break-all">
                    {item.mintOutpoint || `${item.mintTransactionId}.0`}
                  </div>
                </div>

                {/* Current Location (if different from mint) */}
                {item.tokenId && item.tokenId !== item.mintOutpoint && (
                  <div className="space-y-1">
                    <div className="text-xs text-gray-400 font-medium">Current Location</div>
                    <div className="text-xs text-gray-500 font-mono break-all">
                      {item.tokenId}
                    </div>
                    <div className="text-xs text-yellow-400/70">
                      ⚡ Token has been transferred/updated
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                <div className="flex-shrink-0">
                  <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                </div>
                <div>
                  <div className="text-yellow-400 font-medium text-sm">Minting Your NFT...</div>
                  <div className="text-yellow-300/70 text-xs mt-1">
                    Transaction is being created on the blockchain
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Acquired date */}
          <div className="flex justify-between items-center">
            <span className="text-gray-400 text-sm font-medium">Acquired</span>
            <span className="text-white text-sm">
              {new Date(item.acquiredAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })}
            </span>
          </div>

          {/* Custom Border Gradient */}
          {item.borderGradient && (
            <div className="pb-3 border-b border-gray-700">
              <span className="text-gray-400 text-sm font-medium block mb-2">Your Unique Gradient</span>
              <div className="space-y-3">
                {/* Gradient preview */}
                <div
                  className="w-full h-16 rounded-lg border-2"
                  style={{
                    background: `linear-gradient(135deg, ${item.borderGradient.color1}, ${item.borderGradient.color2})`,
                    borderImage: `linear-gradient(135deg, ${item.borderGradient.color1}, ${item.borderGradient.color2}) 1`,
                    boxShadow: `0 0 15px ${item.borderGradient.color1}80, 0 0 15px ${item.borderGradient.color2}80`
                  }}
                />
                {/* Color codes */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded border"
                      style={{
                        backgroundColor: item.borderGradient.color1,
                        boxShadow: `0 0 8px ${item.borderGradient.color1}80`
                      }}
                    />
                    <div className="text-white text-xs font-mono">{item.borderGradient.color1}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded border"
                      style={{
                        backgroundColor: item.borderGradient.color2,
                        boxShadow: `0 0 8px ${item.borderGradient.color2}80`
                      }}
                    />
                    <div className="text-white text-xs font-mono">{item.borderGradient.color2}</div>
                  </div>
                </div>
                <div className="text-gray-500 text-xs text-center">Generated from your public key</div>
              </div>
            </div>
          )}

          {/* Item ID (for reference) */}
          <div className="pt-3 border-t border-gray-700">
            <span className="text-gray-500 text-xs font-mono block">ID: {item.lootId}</span>
          </div>
          </div>
        </div>
        {/* End scrollable content container */}

        {/* Close button at bottom */}
        <button
          onClick={onClose}
          className="mt-6 w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-lg transition-colors cursor-pointer"
        >
          Close
        </button>
      </div>

      {/* Material Mint Modal */}
      {showMaterialModal && (
        <MaterialMintModal
          materialName={item.name}
          tier={item.tier || 1}
          totalCount={item.count || 1}
          icon={item.icon}
          rarity={item.rarity}
          onConfirm={handleMaterialMint}
          onCancel={() => setShowMaterialModal(false)}
          isProcessing={isMintingMaterial}
        />
      )}

      {/* Refine Confirmation Modal */}
      {showRefineConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4">
          <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-lg border-2 border-blue-500 max-w-md w-full p-6 shadow-2xl">
            <div className="text-center mb-6">
              <div className="text-6xl mb-3">💎</div>
              <h3 className="text-xl font-bold text-white mb-2">Refine Equipment?</h3>
              <p className="text-gray-300 text-sm leading-relaxed">
                This will consume <span className="font-bold text-white">1 Refine Stone</span> and reroll the stat variance on <span className="font-bold text-blue-400">{getInscribedItemName(item.name, item.prefix, item.suffix)}</span>.
              </p>
            </div>

            <div className="bg-gray-800/50 border border-gray-600 rounded-lg p-4 mb-6 space-y-2">
              <div className="text-gray-300 text-sm">
                <span className="font-bold text-green-400">How it works:</span>
              </div>
              <div className="text-gray-400 text-xs leading-relaxed">
                • Rolls new stat variance (0.8x - 1.2x base stats)
              </div>
              <div className="text-gray-400 text-xs leading-relaxed">
                • Guarantees minimum <span className="font-bold text-green-400">+1% quality boost</span> per use
              </div>
              <div className="text-gray-400 text-xs leading-relaxed">
                • Never downgrades your item
              </div>
              <div className="text-gray-400 text-xs leading-relaxed mt-2">
                Current Quality: <span className="font-bold text-white">{Math.round(((item.statRoll || 0.8) - 0.8) / 0.4 * 100)}%</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowRefineConfirm(false)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleRefine}
                className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold py-3 rounded-lg transition-all cursor-pointer"
              >
                Refine
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

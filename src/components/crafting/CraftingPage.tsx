'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { CraftingRecipe, getAllRecipes } from '@/lib/recipe-table';
import { getLootItemById, LootItem } from '@/lib/loot-table';
import toast from 'react-hot-toast';
import CraftingItemDetailsModal from './CraftingItemDetailsModal';
import CraftedItemModal from './CraftedItemModal';
import MaterialSelectionModal from './MaterialSelectionModal';
import { getStatRollQuality } from '@/utils/statRollUtils';
import { publicKeyToGradient } from '@/utils/publicKeyToColor';
import { useCraftItemNFT } from '@/hooks/useCraftItemNFT';
import { useAuthContext } from '@/contexts/WalletContext';
import NavigationButtons from '@/components/navigation/NavigationButtons';

type Category = 'all' | 'weapon' | 'armor' | 'consumable' | 'artifact';

interface MaterialCount {
  lootTableId: string;
  quantity: number;
}

interface MaterialItem {
  inventoryId: string;
  materialTokenId?: string;
  lootTableId: string;
  name: string;
  icon: string;
  tier: number;
  quantity: number;
  isMinted: boolean;
  tokenId?: string;
  transactionId?: string;
  isMaterialToken: boolean;
  keyId?: string;
  counterparty?: string;
}

export default function CraftingPage() {
  const router = useRouter();
  const [selectedCategory, setSelectedCategory] = useState<Category>('all');
  const [playerMaterials, setPlayerMaterials] = useState<Map<string, number>>(new Map()); // Counts for UI
  const [playerMaterialItems, setPlayerMaterialItems] = useState<MaterialItem[]>([]); // Full items for crafting
  const [playerLevel, setPlayerLevel] = useState(1);
  const [loading, setLoading] = useState(true);
  const [crafting, setCrafting] = useState<string | null>(null); // recipeId being crafted
  const [selectedItem, setSelectedItem] = useState<LootItem | null>(null); // Item details modal
  const [materialSelectionRecipe, setMaterialSelectionRecipe] = useState<CraftingRecipe | null>(null); // Recipe for material selection modal
  const [craftedItemModal, setCraftedItemModal] = useState<{
    item: LootItem;
    statRoll: number;
    rolledStats?: any;
    isEmpowered?: boolean;
  } | null>(null);

  // Blockchain hooks
  const { craftItemNFT, isCrafting: isBlockchainCrafting } = useCraftItemNFT();
  const { userWallet, isAuthenticated } = useAuthContext();

  // Fetch all data once on mount
  useEffect(() => {
    loadCraftingData();
  }, []);

  const loadCraftingData = async () => {
    try {
      setLoading(true);

      // Fetch player materials (only type: 'material' items, minted only)
      const materialsResponse = await fetch('/api/inventory/get?mintedOnly=true');
      const materialsData = await materialsResponse.json();

      if (materialsResponse.ok && materialsData.success) {
        // Extract material items with full data
        const materialItems: MaterialItem[] = [];
        const materialMap = new Map<string, number>();

        materialsData.inventory.forEach((item: any) => {
          const lootItem = getLootItemById(item.lootId);
          // Backend already filters for minted items, this is a safety check
          if (lootItem && lootItem.type === 'material' && item.tokenId) {
            // Track full material item data
            materialItems.push({
              inventoryId: item.inventoryId,
              materialTokenId: item.materialTokenId,
              lootTableId: item.lootId,
              name: lootItem.name,
              icon: lootItem.icon,
              tier: item.tier || 1,
              quantity: item.quantity || 1,
              isMinted: item.isMinted || false,
              tokenId: item.tokenId,
              transactionId: item.transactionId,
              isMaterialToken: item.isMaterialToken || false,
              keyId: item.keyId,
              counterparty: item.counterparty,
            });

            // Count materials by lootTableId for UI display
            const currentQuantity = item.quantity || 1; // Material tokens have quantity field
            const count = materialMap.get(item.lootId) || 0;
            materialMap.set(item.lootId, count + currentQuantity);
          }
        });

        setPlayerMaterialItems(materialItems);
        setPlayerMaterials(materialMap);
      }

      // Fetch player stats for level
      const statsResponse = await fetch('/api/player-stats');
      const statsData = await statsResponse.json();
      if (statsResponse.ok && statsData.playerStats) {
        setPlayerLevel(statsData.playerStats.level);
      }
    } catch (error) {
      console.error('Error loading crafting data:', error);
      toast.error('Failed to load crafting data');
    } finally {
      setLoading(false);
    }
  };

  // Filter recipes using useMemo to prevent unnecessary recalculations
  const filteredRecipes = useMemo(() => {
    const allRecipes = getAllRecipes();
    if (selectedCategory === 'all') {
      return allRecipes;
    }
    return allRecipes.filter(recipe => recipe.category === selectedCategory);
  }, [selectedCategory]);

  const handleCraft = (recipe: CraftingRecipe) => {
    // Check level requirement
    if (recipe.unlocksAtLevel && playerLevel < recipe.unlocksAtLevel) {
      toast.error(`Requires level ${recipe.unlocksAtLevel}!`);
      return;
    }

    // Check materials
    const missingMaterials: string[] = [];
    for (const req of recipe.requiredMaterials) {
      const playerQuantity = playerMaterials.get(req.lootTableId) || 0;
      if (playerQuantity < req.quantity) {
        const lootItem = getLootItemById(req.lootTableId);
        missingMaterials.push(`${lootItem?.name || req.lootTableId} (need ${req.quantity - playerQuantity} more)`);
      }
    }

    if (missingMaterials.length > 0) {
      toast.error(`Missing materials: ${missingMaterials.join(', ')}`);
      return;
    }

    // Open material selection modal
    setMaterialSelectionRecipe(recipe);
  };

  const handleCraftWithMaterials = async (selectedMaterialIds: string[]) => {
    if (!materialSelectionRecipe) return;

    const recipe = materialSelectionRecipe;

    // Close modal and start crafting
    setMaterialSelectionRecipe(null);
    setCrafting(recipe.recipeId);
    const craftingToast = toast.loading('Preparing to craft...');

    try {
      // Look up the full material items from our state
      const selectedMaterials = selectedMaterialIds
        .map(id => playerMaterialItems.find(m => m.inventoryId === id))
        .filter(m => m !== undefined) as MaterialItem[];

      // Check if ALL selected materials are minted as NFTs
      const allMinted = selectedMaterials.every(m => m.isMinted && m.tokenId);

      console.log('Crafting with materials:', {
        selectedCount: selectedMaterials.length,
        allMinted,
        materials: selectedMaterials.map(m => ({
          name: m.name,
          isMinted: m.isMinted,
          tokenId: m.tokenId,
          quantity: m.quantity
        }))
      });

      // Require wallet authentication and all materials minted
      if (!userWallet || !isAuthenticated) {
        throw new Error('Please connect your wallet to craft items');
      }

      if (!allMinted) {
        throw new Error('All materials must be minted as tokens before crafting. Please mint your materials first.');
      }

      // Use blockchain crafting
      toast.loading('Checking wallet connection...', { id: craftingToast });

      // Get output item data
      const outputLootItem = getLootItemById(recipe.output.lootTableId);
      if (!outputLootItem) {
        throw new Error('Output item not found in loot table');
      }

      toast.loading('Preparing blockchain transaction...', { id: craftingToast });

      // Get user's public key for borderGradient
      const { publicKey } = await userWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
      });

      // Generate borderGradient from public key
      const borderGradient = publicKeyToGradient(publicKey);

      // Prepare input items for blockchain
      const inputItems = selectedMaterials.map(material => {
        const lootItem = getLootItemById(material.lootTableId);
        return {
          inventoryItemId: material.inventoryId,
          nftLootId: material.materialTokenId,
          tokenId: material.tokenId!,
          transactionId: material.transactionId!,
          name: material.name,
          rarity: lootItem?.rarity || 'common',
          type: lootItem?.type || 'material',
          itemType: 'material' as const,
          lootTableId: material.lootTableId,
          currentQuantity: material.quantity,
          quantityNeeded: recipe.requiredMaterials.find(r => r.lootTableId === material.lootTableId)?.quantity || 1,
          description: lootItem?.description,
          icon: lootItem?.icon,
          tier: material.tier,
          keyId: material.keyId,
          counterparty: material.counterparty,
        };
      });

      // Prepare output item data
      const outputItem = {
        inventoryItemId: '', // Will be created by API
        lootTableId: recipe.output.lootTableId,
        name: outputLootItem.name,
        description: outputLootItem.description,
        icon: outputLootItem.icon,
        rarity: outputLootItem.rarity,
        type: outputLootItem.type as 'weapon' | 'armor' | 'consumable' | 'artifact' | 'material',
        tier: recipe.output.tier || 1,
        equipmentStats: outputLootItem.equipmentStats ? { ...outputLootItem.equipmentStats } as Record<string, number> : undefined,
        crafted: outputLootItem.equipmentStats ? {
          statRoll: 0.8 + Math.random() * 0.4, // Generate stat roll (0.8-1.2)
          craftedBy: publicKey
        } : undefined,
        borderGradient
      };

      // Call blockchain crafting hook
      const result = await craftItemNFT({
        wallet: userWallet,
        recipeId: recipe.recipeId,
        inputItems,
        outputItem
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to craft on blockchain');
      }

      toast.success(`✨ Item crafted on blockchain! TX: ${result.transactionId?.slice(0, 8)}...`, {
        id: craftingToast,
        duration: 5000
      });

      // Show crafted item modal if it has stats
      if (outputItem.crafted && outputItem.crafted.statRoll) {
        const quality = getStatRollQuality(outputItem.crafted.statRoll);
        setCraftedItemModal({
          item: outputLootItem,
          statRoll: outputItem.crafted.statRoll,
          rolledStats: outputItem.equipmentStats,
          isEmpowered: false
        });
      }

      // Reload materials
      await loadCraftingData();
    } catch (error) {
      console.error('Error crafting item:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to craft item', { id: craftingToast });
    } finally {
      setCrafting(null);
    }
  };

  const canCraftRecipe = (recipe: CraftingRecipe): boolean => {
    if (recipe.unlocksAtLevel && playerLevel < recipe.unlocksAtLevel) {
      return false;
    }

    for (const req of recipe.requiredMaterials) {
      const playerQuantity = playerMaterials.get(req.lootTableId) || 0;
      if (playerQuantity < req.quantity) {
        return false;
      }
    }

    return true;
  };

  const getRarityColor = (rarity: string) => {
    const colors = {
      common: 'from-gray-600 to-gray-700 border-gray-500',
      rare: 'from-blue-600 to-blue-700 border-blue-500',
      epic: 'from-purple-600 to-purple-700 border-purple-500',
      legendary: 'from-amber-600 to-amber-700 border-amber-500'
    };
    return colors[rarity as keyof typeof colors] || colors.common;
  };

  const getRarityTextColor = (rarity: string) => {
    const colors = {
      common: 'text-gray-400',
      rare: 'text-blue-400',
      epic: 'text-purple-400',
      legendary: 'text-amber-400'
    };
    return colors[rarity as keyof typeof colors] || colors.common;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4 animate-bounce">🔨</div>
          <p className="text-gray-400 text-lg">Loading crafting recipes...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-4 md:p-8">
      {/* Header */}
      <div className="max-w-7xl mx-auto mb-6">
        {/* Title Section */}
        <div className="mb-4">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">⚒️ Crafting Workshop</h1>
          <p className="text-gray-400">Combine materials to create powerful items</p>
        </div>

        {/* Navigation Bar */}
        <NavigationButtons
          showMarketplace
          showBlacksmith
          showInventory
          showBattle
          showLogout
        />
      </div>

      {/* Category Tabs */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="flex gap-2 flex-wrap">
          {(['all', 'weapon', 'armor', 'consumable', 'artifact'] as Category[]).map(category => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`px-6 py-3 rounded-lg font-bold transition-all cursor-pointer ${
                selectedCategory === category
                  ? 'bg-purple-600 text-white shadow-lg scale-105'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 border-2 border-gray-700'
              }`}
            >
              {category === 'all' ? '🗂️ All' : ''}
              {category === 'weapon' ? '⚔️ Weapons' : ''}
              {category === 'armor' ? '🛡️ Armor' : ''}
              {category === 'consumable' ? '🧪 Consumables' : ''}
              {category === 'artifact' ? '💍 Artifacts' : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Recipes Container */}
      <div className="max-w-7xl mx-auto">
        <div className="relative bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl border-4 border-gray-700 p-8 shadow-2xl">
          {/* Decorative elements */}
          <div className="absolute -top-6 left-8 text-3xl">⚒️</div>
          <div className="absolute -top-6 right-8 text-3xl">⚒️</div>

          {/* Empty state */}
          {filteredRecipes.length === 0 ? (
            <div className="text-center py-20">
              <div className="text-8xl mb-6">🔨</div>
              <h2 className="text-2xl font-bold text-gray-300 mb-3">No recipes in this category</h2>
              <p className="text-gray-400">
                Try selecting a different category to see available recipes
              </p>
            </div>
          ) : (
            /* Recipes Grid */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-8">
              {filteredRecipes.map(recipe => {
                const outputItem = getLootItemById(recipe.output.lootTableId);
                const canCraft = canCraftRecipe(recipe);
                const isLocked = recipe.unlocksAtLevel && playerLevel < recipe.unlocksAtLevel;

                const isCrafting = crafting === recipe.recipeId;
                const isDisabled = Boolean(!canCraft || isCrafting || isLocked);

                return (
                  <div
                    key={recipe.recipeId}
                    className={`
                      relative bg-gradient-to-br ${getRarityColor(recipe.rarity)} rounded-xl border-4 p-5 transition-all flex flex-col
                      ${canCraft && !isLocked ? 'hover:scale-105 hover:shadow-2xl hover:z-20' : ''}
                      ${isLocked ? 'opacity-60' : ''}
                    `}
                  >
                    {/* Lock Badge */}
                    {isLocked && (
                      <div className="absolute top-2 right-2 px-3 py-1 bg-red-600 text-white rounded-lg text-xs font-bold border-2 border-red-400">
                        🔒 Level {recipe.unlocksAtLevel}
                      </div>
                    )}

                    {/* Recipe Header */}
                    <div className="flex items-center gap-3 mb-4">
                      <span className="text-4xl">{recipe.icon}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <div className={`text-lg font-bold ${getRarityTextColor(recipe.rarity)}`}>
                            {recipe.name}
                          </div>
                          <button
                            onClick={() => outputItem && setSelectedItem(outputItem)}
                            className="text-gray-400 hover:text-white transition-colors cursor-pointer"
                            title="View item details"
                          >
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                        <div className="text-xs text-gray-300">{recipe.description}</div>
                      </div>
                    </div>

                    {/* Materials Required - grows to fill space */}
                    <div className="mb-4 flex-grow">
                      <div className="text-sm text-gray-300 font-bold mb-2">Materials Required:</div>
                      <div className="space-y-1">
                        {recipe.requiredMaterials.map(req => {
                          const material = getLootItemById(req.lootTableId);
                          const playerQuantity = playerMaterials.get(req.lootTableId) || 0;
                          const hasEnough = playerQuantity >= req.quantity;

                          return (
                            <div key={req.lootTableId} className="flex justify-between text-sm bg-gray-900/50 px-3 py-2 rounded">
                              <span className={hasEnough ? 'text-green-400' : 'text-red-400'}>
                                {material?.icon} {material?.name}
                              </span>
                              <span className={hasEnough ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                                {playerQuantity} / {req.quantity}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Output - fixed at bottom */}
                    <div className="mb-4 pt-3 border-t-2 border-gray-600 mt-auto">
                      <div className="text-sm text-gray-300 font-bold mb-2">Creates:</div>
                      <div className="flex items-center gap-2 bg-gray-900/50 px-3 py-2 rounded">
                        <span className="text-2xl">{outputItem?.icon}</span>
                        <span className="text-base font-semibold text-white">
                          {recipe.output.quantity}x {outputItem?.name}
                        </span>
                      </div>
                    </div>

                    {/* Craft Button - fixed at bottom */}
                    <button
                      onClick={() => handleCraft(recipe)}
                      disabled={isDisabled}
                      className={`
                        w-full py-3 rounded-lg font-bold transition-all text-base flex items-center justify-center gap-2
                        ${canCraft && !isLocked
                          ? 'bg-purple-600 text-white hover:bg-purple-700 shadow-lg cursor-pointer'
                          : 'bg-gray-700 text-gray-400 cursor-not-allowed'
                        }
                        ${isCrafting ? 'opacity-50' : ''}
                      `}
                    >
                      {isCrafting && (
                        <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      )}
                      {isCrafting ? '🔨 Crafting...' : isLocked ? '🔒 Locked' : canCraft ? '🔨 Craft' : '❌ Missing Materials'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Item Details Modal */}
      {selectedItem && (
        <CraftingItemDetailsModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}

      {/* Crafted Item Modal */}
      {craftedItemModal && (
        <CraftedItemModal
          item={craftedItemModal.item}
          statRoll={craftedItemModal.statRoll}
          rolledStats={craftedItemModal.rolledStats}
          isEmpowered={craftedItemModal.isEmpowered}
          onClose={() => setCraftedItemModal(null)}
        />
      )}

      {/* Material Selection Modal */}
      {materialSelectionRecipe && (
        <MaterialSelectionModal
          recipe={materialSelectionRecipe}
          onClose={() => setMaterialSelectionRecipe(null)}
          onCraft={handleCraftWithMaterials}
        />
      )}
    </div>
  );
}

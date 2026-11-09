
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { CraftingRecipe, MaterialRequirement } from '@shared/recipe-table';
import { getLootItemById } from '@shared/loot-table';
import { TierBadge, EmpoweredBadge } from '@/components/badges';
import toast from 'react-hot-toast';

interface MaterialSelectionModalProps {
  recipe: CraftingRecipe;
  onClose: () => void;
  onCraft: (selectedMaterialIds: string[]) => void;
}

interface InventoryMaterial {
  _id: string;
  lootTableId: string;
  tier: 1 | 2 | 3 | 4 | 5;
  isEmpowered?: boolean;
  borderGradient: { color1: string; color2: string };
  quantity: number; // For material tokens (1 for regular materials)
  isMinted: boolean;
  tokenId?: string;
  transactionId?: string;
  isMaterialToken: boolean;
  materialTokenId?: string;
}

export default function MaterialSelectionModal({ recipe, onClose, onCraft }: MaterialSelectionModalProps) {
  const [userMaterials, setUserMaterials] = useState<InventoryMaterial[]>([]);
  const [selectedMaterials, setSelectedMaterials] = useState<Map<string, string[]>>(new Map()); // lootTableId -> array of _id
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUserMaterials();
  }, []);

  const loadUserMaterials = async () => {
    try {
      setLoading(true);
      // Only fetch minted materials (backend filtering)
      const response = await apiFetch('/api/inventory/get?mintedOnly=true&excludeListed=true'); // listed tokens sit in an OrdLock
      const data = await response.json();

      if (response.ok && data.success) {
        // Backend already filters for minted items, this is a safety check
        const materials = data.inventory
          .filter((item: any) => {
            const lootItem = getLootItemById(item.lootId);
            return lootItem && lootItem.type === 'material' && item.tokenId;
          })
          .map((item: any) => ({
            _id: item.inventoryId, // API returns inventoryId, not _id
            lootTableId: item.lootId,
            tier: item.tier || 1,
            isEmpowered: item.isEmpowered,
            borderGradient: item.borderGradient,
            quantity: item.quantity || 1, // Material tokens have quantity, regular items are 1
            isMinted: item.isMinted || false,
            tokenId: item.tokenId,
            transactionId: item.transactionId,
            isMaterialToken: item.isMaterialToken || false,
            materialTokenId: item.materialTokenId
          }));

        setUserMaterials(materials);
      } else {
        toast.error('Failed to load materials');
      }
    } catch (error) {
      console.error('Error loading materials:', error);
      toast.error('Failed to load materials');
    } finally {
      setLoading(false);
    }
  };

  // Calculate total quantity for a given lootTableId from selected materials
  const getSelectedQuantity = (lootTableId: string): number => {
    const selectedIds = selectedMaterials.get(lootTableId) || [];
    return selectedIds.reduce((total, id) => {
      const material = userMaterials.find(m => m._id === id);
      return total + (material?.quantity || 0);
    }, 0);
  };

  const handleMaterialClick = (material: InventoryMaterial) => {
    const requirement = recipe.requiredMaterials.find(r => r.lootTableId === material.lootTableId);
    if (!requirement) {
      console.warn('No requirement found for material:', material.lootTableId);
      return;
    }

    setSelectedMaterials(prevMap => {
      const currentSelected = prevMap.get(material.lootTableId) || [];
      const materialId = material._id;

      // Calculate current total quantity
      const currentQuantity = currentSelected.reduce((total, id) => {
        const mat = userMaterials.find(m => m._id === id);
        return total + (mat?.quantity || 0);
      }, 0);

      // Check if already selected
      if (currentSelected.includes(materialId)) {
        // Deselect
        const newSelected = currentSelected.filter(id => id !== materialId);
        const newMap = new Map(prevMap);
        if (newSelected.length === 0) {
          newMap.delete(material.lootTableId);
        } else {
          newMap.set(material.lootTableId, newSelected);
        }
        return newMap;
      } else {
        // Select (only allow if we haven't met requirement yet)
        const newQuantity = currentQuantity + material.quantity;

        // Allow selection if we haven't met the requirement yet
        // This allows selecting a single token with quantity >= requirement
        if (currentQuantity < requirement.quantity) {
          const newSelected = [...currentSelected, materialId];
          const newMap = new Map(prevMap);
          newMap.set(material.lootTableId, newSelected);
          return newMap;
        } else {
          // Already have enough materials
          toast.error(
            `Already have enough ${material.lootTableId} (have ${currentQuantity}, need ${requirement.quantity})`
          );
          return prevMap; // Return unchanged map
        }
      }
    });
  };

  const isMaterialSelected = (materialId: string): boolean => {
    for (const ids of selectedMaterials.values()) {
      if (ids.includes(materialId)) {
        return true;
      }
    }
    return false;
  };

  const canCraft = (): boolean => {
    // Check if all requirements are met (selected quantity >= required quantity)
    for (const req of recipe.requiredMaterials) {
      const selectedQuantity = getSelectedQuantity(req.lootTableId);
      if (selectedQuantity < req.quantity) return false;
    }
    return true;
  };

  const handleCraft = () => {
    if (!canCraft()) return;

    // Flatten all selected material IDs into a single array
    const allSelectedIds: string[] = [];
    for (const ids of selectedMaterials.values()) {
      allSelectedIds.push(...ids);
    }

    onCraft(allSelectedIds);
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
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
        <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-8 max-w-4xl w-full border-4 border-gray-700">
          <div className="text-center">
            <div className="text-6xl mb-4 animate-bounce">📦</div>
            <p className="text-gray-400 text-lg">Loading materials...</p>
          </div>
        </div>
      </div>
    );
  }

  const outputItem = getLootItemById(recipe.output.lootTableId);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-8 max-w-6xl w-full border-4 border-purple-600 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-3xl font-bold text-white mb-2">
              {recipe.icon} Select Materials to Craft
            </h2>
            <p className={`text-xl font-semibold ${getRarityTextColor(recipe.rarity)}`}>
              {recipe.name}
            </p>
            <p className="text-gray-400 text-sm">{recipe.description}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-4xl leading-none cursor-pointer"
          >
            ×
          </button>
        </div>

        {/* Requirements Section */}
        <div className="mb-6">
          <h3 className="text-xl font-bold text-white mb-3">Requirements</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {recipe.requiredMaterials.map(req => {
              const material = getLootItemById(req.lootTableId);
              const selectedQuantity = getSelectedQuantity(req.lootTableId);
              const isComplete = selectedQuantity >= req.quantity;

              return (
                <div
                  key={`req-${req.lootTableId}`}
                  className={`flex justify-between items-center px-4 py-3 rounded-lg border-2 ${
                    isComplete
                      ? 'bg-green-900/30 border-green-500'
                      : 'bg-gray-900/50 border-gray-600'
                  }`}
                >
                  <span className={`font-semibold ${isComplete ? 'text-green-400' : 'text-gray-300'}`}>
                    {material?.icon} {material?.name}
                  </span>
                  <span className={`text-lg font-bold ${isComplete ? 'text-green-400' : 'text-red-400'}`}>
                    {selectedQuantity} / {req.quantity}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Materials Inventory */}
        <div className="mb-6">
          <h3 className="text-xl font-bold text-white mb-3">Your Materials (Click to Select)</h3>

          {recipe.requiredMaterials.map(req => {
            const material = getLootItemById(req.lootTableId);
            const availableMaterials = userMaterials.filter(m => m.lootTableId === req.lootTableId);

            if (availableMaterials.length === 0) return null;

            return (
              <div key={`mat-section-${req.lootTableId}`} className="mb-4">
                <h4 className="text-lg font-semibold text-gray-300 mb-2">
                  {material?.icon} {material?.name}
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {availableMaterials.map(mat => {
                    const isSelected = isMaterialSelected(mat._id);
                    const lootItem = getLootItemById(mat.lootTableId);

                    return (
                      <div
                        key={mat._id}
                        onClick={() => handleMaterialClick(mat)}
                        className={`
                          relative cursor-pointer transition-all
                          bg-gradient-to-br ${lootItem ? getRarityColor(lootItem.rarity) : 'from-gray-700 to-gray-800'}
                          rounded-xl border-4 p-4
                          ${isSelected ? 'border-green-500 shadow-lg shadow-green-500/50 scale-105 z-20' : 'hover:scale-105 hover:z-20'}
                        `}
                      >
                        {/* Selected Checkmark */}
                        {isSelected && (
                          <div className="absolute top-1 right-1 w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                            <span className="text-white text-sm font-bold">✓</span>
                          </div>
                        )}

                        {/* Material Icon */}
                        <div className="text-4xl text-center mb-2">{lootItem?.icon}</div>

                        {/* Quantity Badge (bottom-center) */}
                        {mat.quantity > 1 && (
                          <div className="absolute bottom-12 left-1/2 transform -translate-x-1/2 px-2 py-1 bg-blue-600 rounded-lg text-xs font-bold border-2 border-blue-400">
                            x{mat.quantity}
                          </div>
                        )}

                        {/* Badges */}
                        <div className="flex justify-between items-end">
                          <TierBadge tier={mat.tier} />
                          {mat.isEmpowered && <EmpoweredBadge />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Output Preview */}
        <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border-2 border-gray-600">
          <h3 className="text-lg font-bold text-white mb-2">You Will Craft:</h3>
          <div className="flex items-center gap-3">
            <span className="text-4xl">{outputItem?.icon}</span>
            <div>
              <p className={`text-xl font-bold ${outputItem ? getRarityTextColor(outputItem.rarity) : 'text-white'}`}>
                {recipe.output.quantity}x {outputItem?.name}
              </p>
              <p className="text-sm text-gray-400">{outputItem?.description}</p>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4">
          <button
            onClick={onClose}
            className="flex-1 px-6 py-4 bg-gray-700 hover:bg-gray-600 text-white font-bold rounded-lg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleCraft}
            disabled={!canCraft()}
            className={`
              flex-1 px-6 py-4 rounded-lg font-bold text-lg transition-all
              ${canCraft()
                ? 'bg-purple-600 hover:bg-purple-700 text-white shadow-lg cursor-pointer'
                : 'bg-gray-700 text-gray-400 cursor-not-allowed'
              }
            `}
          >
            {canCraft() ? '🔨 Craft Item' : '❌ Select Required Materials'}
          </button>
        </div>
      </div>
    </div>
  );
}

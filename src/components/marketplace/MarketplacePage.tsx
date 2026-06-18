'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { useAuthContext } from '@/contexts/WalletContext';
import { usePlayer } from '@/contexts/PlayerContext';
import toast from 'react-hot-toast';
import SellItemModal from './SellItemModal';
import MarketplaceItemDetailsModal from './MarketplaceItemDetailsModal';
import SoldProceedsModal from './SoldProceedsModal';
import NavigationButtons from '@/components/navigation/NavigationButtons';

interface MarketplaceItem {
  _id: string;
  sellerId: string;
  sellerUsername: string;
  lootTableId: string;
  itemName: string;
  itemIcon: string;
  itemType: string;
  rarity: string;
  tier?: number;
  tokenId?: string;
  transactionId?: string;
  quantity?: number;
  price: number;
  listedAt: Date;
  equipmentStats?: Record<string, number>;
  crafted?: boolean;
  statRoll?: number;
  isEmpowered?: boolean;
  prefix?: any;
  suffix?: any;
}

export default function MarketplacePage() {
  const router = useRouter();
  const { userWallet } = useAuthContext();
  const { playerStats } = usePlayer();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [showSellModal, setShowSellModal] = useState(false);
  const [showInboxModal, setShowInboxModal] = useState(false);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [selectedItem, setSelectedItem] = useState<MarketplaceItem | null>(null);

  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [selectedRarity, setSelectedRarity] = useState('');
  const [selectedTier, setSelectedTier] = useState('');
  const [showMyListings, setShowMyListings] = useState(false);

  const loadMarketplaceItems = useCallback(async () => {
    // Build query params from filter states
    const params = new URLSearchParams();
    if (searchQuery) params.append('search', searchQuery);
    if (selectedType) params.append('itemType', selectedType);
    if (selectedRarity) params.append('rarity', selectedRarity);
    if (selectedTier) params.append('tier', selectedTier);

    try {
      setLoading(true);
      const url = params.toString()
        ? `/api/marketplace/items?${params.toString()}`
        : '/api/marketplace/items';

      const response = await fetch(url);
      const data = await response.json();

      if (response.ok && data.success) {
        let filteredItems = data.items;

        // Apply "My Listings" filter client-side
        if (showMyListings && playerStats?.userId) {
          filteredItems = filteredItems.filter(
            (item: MarketplaceItem) => item.sellerId === playerStats.userId
          );
        }

        setItems(filteredItems);
      } else {
        toast.error('Failed to load marketplace items');
      }
    } catch (error) {
      console.error('Error loading marketplace:', error);
      toast.error('Failed to load marketplace');
    } finally {
      setLoading(false);
    }
  }, [searchQuery, selectedType, selectedRarity, selectedTier, showMyListings, playerStats?.userId]);

  // Load count of unclaimed sale proceeds for the Inbox badge
  const loadUnclaimedCount = useCallback(async () => {
    try {
      const response = await fetch('/api/marketplace/my-sales');
      const data = await response.json();
      if (response.ok && data.success) {
        const unclaimed = (data.sales as { payoutClaimed: boolean }[]).filter(
          (s) => !s.payoutClaimed
        ).length;
        setUnclaimedCount(unclaimed);
      }
    } catch (error) {
      console.error('Error loading sold-items count:', error);
    }
  }, []);

  useEffect(() => {
    loadUnclaimedCount();
  }, [loadUnclaimedCount]);

  // Debounced search effect
  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      loadMarketplaceItems();
    }, 500); // 500ms debounce

    return () => clearTimeout(debounceTimer);
  }, [loadMarketplaceItems]);

  const getRarityColor = (rarity: string) => {
    const colors = {
      common: 'from-gray-600 to-gray-700 border-gray-500',
      rare: 'from-blue-600 to-blue-700 border-blue-500',
      epic: 'from-purple-600 to-purple-700 border-purple-500',
      legendary: 'from-amber-600 to-amber-700 border-amber-500'
    };
    return colors[rarity as keyof typeof colors] || colors.common;
  };

  const getItemDisplayName = (item: MarketplaceItem) => {
    // Build name with inscriptions: "Prefix BaseName Suffix"
    const parts: string[] = [];

    if (item.prefix?.name) {
      parts.push(item.prefix.name);
    }

    parts.push(item.itemName);

    if (item.suffix?.name) {
      parts.push(item.suffix.name);
    }

    return parts.join(' ');
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 dark:from-purple-950 dark:via-blue-950 dark:to-indigo-950">
        <div className="text-white text-2xl animate-pulse">Loading marketplace...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 dark:from-purple-950 dark:via-blue-950 dark:to-indigo-950 p-4">
      {/* Header */}
      <div className="max-w-7xl mx-auto mb-6">
        {/* Title Section */}
        <div className="mb-4">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">🏪 Marketplace</h1>
          <p className="text-gray-400">Buy and sell items with other players</p>
          {!userWallet && (
            <p className="text-yellow-400 text-sm mt-2">⚠️ Connect wallet to list or purchase items</p>
          )}
        </div>

        {/* Navigation Bar — nav buttons left, Inbox right */}
        <div className="flex items-center justify-between gap-2">
          <NavigationButtons
            showBattle
            showInventory
          />
          <button
            onClick={() => setShowInboxModal(true)}
            className="relative px-3 sm:px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition-colors shadow-lg cursor-pointer flex items-center justify-center gap-2 text-sm md:text-base"
            title="Claim proceeds from sold items"
          >
            <span className="text-xl">📥</span>
            <span className="hidden sm:inline">Inbox</span>
            {unclaimedCount > 0 && (
              <span className="absolute -top-2 -right-2 bg-red-600 text-white text-xs font-bold rounded-full min-w-[1.25rem] h-5 px-1 flex items-center justify-center">
                {unclaimedCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto">

        {/* Filters */}
        <div className="bg-white/10 backdrop-blur-lg rounded-xl p-6 border border-white/20 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
            {/* Search Input */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search items..."
              className="px-4 py-2 rounded-lg bg-gray-800/90 border border-white/20 text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />

            {/* Type Filter */}
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="px-4 py-2 rounded-lg bg-gray-800/90 border border-white/20 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 cursor-pointer appearance-none [&>option]:bg-gray-800 [&>option]:text-white"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%23ffffff' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m6 8 4 4 4-4'/%3E%3C/svg%3E")`, backgroundPosition: 'right 0.5rem center', backgroundRepeat: 'no-repeat', backgroundSize: '1.5em 1.5em' }}
            >
              <option value="">All Types</option>
              <option value="weapon">Weapon</option>
              <option value="armor">Armor</option>
              <option value="artifact">Artifact</option>
              <option value="consumable">Consumable</option>
              <option value="material">Material</option>
            </select>

            {/* Rarity Filter */}
            <select
              value={selectedRarity}
              onChange={(e) => setSelectedRarity(e.target.value)}
              className="px-4 py-2 rounded-lg bg-gray-800/90 border border-white/20 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 cursor-pointer appearance-none [&>option]:bg-gray-800 [&>option]:text-white"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%23ffffff' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m6 8 4 4 4-4'/%3E%3C/svg%3E")`, backgroundPosition: 'right 0.5rem center', backgroundRepeat: 'no-repeat', backgroundSize: '1.5em 1.5em' }}
            >
              <option value="">All Rarities</option>
              <option value="common">Common</option>
              <option value="rare">Rare</option>
              <option value="epic">Epic</option>
              <option value="legendary">Legendary</option>
            </select>

            {/* Tier Filter */}
            <select
              value={selectedTier}
              onChange={(e) => setSelectedTier(e.target.value)}
              className="px-4 py-2 rounded-lg bg-gray-800/90 border border-white/20 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 cursor-pointer appearance-none [&>option]:bg-gray-800 [&>option]:text-white"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%23ffffff' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m6 8 4 4 4-4'/%3E%3C/svg%3E")`, backgroundPosition: 'right 0.5rem center', backgroundRepeat: 'no-repeat', backgroundSize: '1.5em 1.5em' }}
            >
              <option value="">All Tiers</option>
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3">Tier 3</option>
              <option value="4">Tier 4</option>
              <option value="5">Tier 5</option>
            </select>

            {/* My Listings Filter */}
            <button
              onClick={() => setShowMyListings(!showMyListings)}
              className={`
                px-4 py-2 rounded-lg border transition-colors font-semibold flex items-center justify-center gap-2
                ${showMyListings
                  ? 'bg-purple-600 border-purple-500 text-white'
                  : 'bg-gray-800/90 border-white/20 text-white hover:bg-gray-700/90'
                }
              `}
              title="Show only your listings"
            >
              <span className="text-xl">👤</span>
              <span className="hidden sm:inline">My Listings</span>
            </button>

            {/* Sell Item Button */}
            <button
              onClick={() => setShowSellModal(true)}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors shadow-lg cursor-pointer font-semibold flex items-center justify-center gap-2"
              title="List an item for sale"
            >
              <span className="text-xl">+</span>
              <span className="hidden sm:inline">Sell Item</span>
            </button>
          </div>
        </div>

        {/* Empty State */}
        {items.length === 0 && (
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-12 border border-white/20 text-center">
            <div className="text-6xl mb-4">🏪</div>
            <h2 className="text-2xl font-bold text-white mb-4">
              {showMyListings ? 'No Listings Found' : 'No Items Listed Yet'}
            </h2>
            <p className="text-gray-300 mb-4">
              {showMyListings
                ? 'You have no active listings. List an item to get started!'
                : 'Be the first to list an item on the marketplace!'}
            </p>
            <button
              onClick={() => setShowSellModal(true)}
              className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition-colors shadow-lg cursor-pointer inline-block"
            >
              + List Your First Item
            </button>
          </div>
        )}

        {/* Items Grid */}
        {items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {items.map((item) => (
              <div
                key={item._id}
                onClick={() => setSelectedItem(item)}
                className={`
                  relative cursor-pointer transition-all
                  bg-gradient-to-br ${getRarityColor(item.rarity)}
                  rounded-xl border-4 p-4 hover:scale-105 hover:z-20
                `}
              >
                {/* Icon */}
                <div className="text-4xl text-center mb-2">{item.itemIcon}</div>

                {/* Name */}
                <p className="text-white text-sm font-semibold text-center truncate mb-1">
                  {getItemDisplayName(item)}
                </p>

                {/* Tier */}
                {item.tier && (
                  <div className="text-xs text-center text-gray-300 mb-2">
                    Tier {item.tier}
                  </div>
                )}

                {/* Price */}
                <div className="text-center bg-black/30 rounded py-1 mb-2">
                  <p className="text-yellow-400 font-bold text-sm">{item.price} sats</p>
                </div>

                {/* Seller */}
                <div className="text-xs text-center text-gray-400 truncate">
                  by {item.sellerUsername}
                </div>

                {/* My Listing Badge */}
                {playerStats?.userId && item.sellerId === playerStats.userId && (
                  <div className="absolute top-1 left-1 bg-purple-600 text-white text-xs font-bold px-2 py-1 rounded">
                    Mine
                  </div>
                )}

                {/* Quantity (for materials) */}
                {item.quantity && item.quantity > 1 && (
                  <div className="absolute top-1 right-1 bg-green-600 text-white text-xs font-bold px-2 py-1 rounded">
                    x{item.quantity}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sell Item Modal */}
      {showSellModal && (
        <SellItemModal
          wallet={userWallet}
          onClose={() => setShowSellModal(false)}
          onSuccess={() => {
            loadMarketplaceItems();
          }}
        />
      )}

      {/* Sold Items Inbox Modal */}
      {showInboxModal && (
        <SoldProceedsModal
          wallet={userWallet}
          onClose={() => setShowInboxModal(false)}
          onClaimed={() => {
            loadUnclaimedCount();
          }}
        />
      )}

      {/* Item Details Modal */}
      {selectedItem && playerStats && (
        <MarketplaceItemDetailsModal
          item={selectedItem}
          currentUserId={playerStats.userId}
          wallet={userWallet}
          onClose={() => setSelectedItem(null)}
          onSuccess={() => {
            loadMarketplaceItems();
          }}
        />
      )}
    </div>
  );
}

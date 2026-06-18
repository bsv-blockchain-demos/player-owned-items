'use client';

import { useState, useEffect, useCallback } from 'react';
import { WalletClient } from '@bsv/sdk';
import toast from 'react-hot-toast';
import { getTransactionByTxID } from '@/utils/overlayFunctions';
import { internalizeToBasket } from '@/utils/internalizeToBasket';

interface SaleItem {
  _id: string;
  itemName: string;
  itemIcon: string;
  rarity: string;
  price: number;
  payoutOutpoint: string;
  listingNonce?: string;
  payoutClaimed: boolean;
  soldAt?: string;
}

interface SoldProceedsModalProps {
  wallet: WalletClient | null;
  onClose: () => void;
  onClaimed?: () => void;
}

export default function SoldProceedsModal({ wallet, onClose, onClaimed }: SoldProceedsModalProps) {
  const [loading, setLoading] = useState(true);
  const [sales, setSales] = useState<SaleItem[]>([]);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const getRarityColor = (rarity: string) => {
    const colors = {
      common: 'from-gray-600 to-gray-700 border-gray-500',
      rare: 'from-blue-600 to-blue-700 border-blue-500',
      epic: 'from-purple-600 to-purple-700 border-purple-500',
      legendary: 'from-amber-600 to-amber-700 border-amber-500'
    };
    return colors[rarity as keyof typeof colors] || colors.common;
  };

  const loadSales = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/marketplace/my-sales');
      const data = await response.json();
      if (response.ok && data.success) {
        setSales(data.sales);
      } else {
        toast.error('Failed to load sold items');
      }
    } catch (error) {
      console.error('Error loading sold items:', error);
      toast.error('Failed to load sold items');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSales();
  }, [loadSales]);

  const handleClaim = async (sale: SaleItem) => {
    if (!wallet) {
      toast.error('Wallet not connected');
      return;
    }
    if (!sale.listingNonce) {
      toast.error('Listing is missing derivation data (legacy listing)');
      return;
    }

    setClaimingId(sale._id);
    const loadingToast = toast.loading('Claiming proceeds...');

    try {
      const isAuthenticated = await wallet.isAuthenticated();
      if (!isAuthenticated) {
        throw new Error('Wallet not authenticated');
      }

      // Server identity key is the derivation counterparty the payout output was locked toward.
      const serverIdentityKeyRes = await fetch('/api/server-identity-key');
      const { publicKey: serverIdentityKey } = await serverIdentityKeyRes.json();

      // Resolve the purchase tx that contains the seller-payment output (output 1).
      const [txid] = sale.payoutOutpoint.split('.');
      const ov = await getTransactionByTxID(txid);
      const beef = ov?.outputs?.[0]?.beef;
      if (!beef) {
        toast.error('Proceeds not available yet (tx not indexed)', { id: loadingToast });
        return;
      }

      // Internalize output 1 (seller payment) into the owner's token basket.
      await internalizeToBasket(
        wallet,
        beef,
        [{
          outputIndex: 1,
          keyId: sale.listingNonce,
          counterparty: serverIdentityKey,
          tags: ['type:proceeds'],
        }],
        'Sale proceeds',
      );

      const response = await fetch('/api/marketplace/claim-proceeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId: sale._id }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to record claim');
      }

      // Mark claimed in local state
      setSales(prev => prev.map(s => s._id === sale._id ? { ...s, payoutClaimed: true } : s));
      toast.success(`Claimed ${sale.price} sats from ${sale.itemName}`, { id: loadingToast });
      onClaimed?.();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to claim proceeds';
      toast.error(errorMessage, { id: loadingToast });
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gradient-to-br from-indigo-800 to-purple-900 rounded-2xl p-8 max-w-2xl w-full border-4 border-purple-500 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-3xl font-bold text-white mb-1">📥 Sold Items</h2>
            <p className="text-gray-300">Claim the proceeds from your sales</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-4xl leading-none cursor-pointer"
          >
            ×
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div className="text-white text-center py-12 animate-pulse">Loading sold items...</div>
        ) : sales.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-6xl mb-4">📭</div>
            <p className="text-gray-300">No sold items yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sales.map((sale) => (
              <div
                key={sale._id}
                className={`
                  flex items-center gap-4 rounded-xl border-4 p-4
                  bg-gradient-to-br ${getRarityColor(sale.rarity)}
                  ${sale.payoutClaimed ? 'opacity-50' : ''}
                `}
              >
                <div className="text-4xl">{sale.itemIcon}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-semibold truncate">{sale.itemName}</p>
                  <p className="text-yellow-400 font-bold text-sm">{sale.price} sats</p>
                  {sale.soldAt && (
                    <p className="text-xs text-gray-300">
                      Sold {new Date(sale.soldAt).toLocaleString()}
                    </p>
                  )}
                </div>
                {sale.payoutClaimed ? (
                  <span className="px-4 py-2 bg-green-700/60 text-green-200 font-bold rounded-lg text-sm whitespace-nowrap">
                    ✅ Claimed
                  </span>
                ) : (
                  <button
                    onClick={() => handleClaim(sale)}
                    disabled={claimingId !== null || !wallet}
                    className={`
                      px-4 py-2 rounded-lg font-bold text-sm transition-all whitespace-nowrap
                      ${claimingId === null && wallet
                        ? 'bg-green-600 hover:bg-green-700 text-white shadow-lg cursor-pointer'
                        : 'bg-gray-700 text-gray-400 cursor-not-allowed'
                      }
                    `}
                  >
                    {claimingId === sale._id ? 'Claiming...' : '💰 Claim proceeds'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {!wallet && sales.length > 0 && (
          <p className="text-center text-red-400 text-sm mt-4">
            ⚠️ Connect wallet to claim proceeds
          </p>
        )}
      </div>
    </div>
  );
}

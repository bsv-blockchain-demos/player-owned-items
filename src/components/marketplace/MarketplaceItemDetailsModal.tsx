'use client';

import { useState } from 'react';
import { WalletClient, Transaction, Script } from '@bsv/sdk';
import { createWalletPayment } from '@/utils/createWalletPayment';
import toast from 'react-hot-toast';
import { WalletOrdLock } from '@bsv/wallet-helper';
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';
import { broadcastTX, getTransactionByTxID } from '@/utils/overlayFunctions';

interface MarketplaceItemDetailsModalProps {
  item: {
    _id: string;
    sellerId: string;
    sellerUsername: string;
    itemName: string;
    itemIcon: string;
    itemType: string;
    rarity: string;
    tier?: number;
    price: number;
    listedAt: Date;
    equipmentStats?: Record<string, number>;
    crafted?: boolean;
    statRoll?: number;
    isEmpowered?: boolean;
    prefix?: any;
    suffix?: any;
    quantity?: number;
  };
  currentUserId: string;
  wallet: WalletClient | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function MarketplaceItemDetailsModal({
  item,
  currentUserId,
  wallet,
  onClose,
  onSuccess
}: MarketplaceItemDetailsModalProps) {
  const [processing, setProcessing] = useState(false);

  const isOwnListing = item.sellerId === currentUserId;

  const getRarityColor = (rarity: string) => {
    const colors = {
      common: 'from-gray-600 to-gray-700 border-gray-500',
      rare: 'from-blue-600 to-blue-700 border-blue-500',
      epic: 'from-purple-600 to-purple-700 border-purple-500',
      legendary: 'from-amber-600 to-amber-700 border-amber-500'
    };
    return colors[rarity as keyof typeof colors] || colors.common;
  };

  const getItemDisplayName = () => {
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

  const handleCancel = async () => {
    if (!wallet) {
      toast.error('Wallet not connected');
      return;
    }

    setProcessing(true);
    const loadingToast = toast.loading('Cancelling listing...');

    try {
      const isAuthenticated = await wallet.isAuthenticated();
      if (!isAuthenticated) {
        throw new Error('Wallet not authenticated');
      }

      // Get user's public key
      const { publicKey } = await wallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
      });

      const listingRes = await fetch(`/api/marketplace/listing/${item._id}`);
      const listingData = await listingRes.json();
      if (!listingRes.ok) {
        throw new Error(listingData.error || 'Failed to fetch listing details');
      }

      const listing = listingData.listing;
      if (!listing?.ordLockOutpoint || !listing?.ordLockScript || !listing?.assetId) {
        throw new Error('Listing missing OrdLock data');
      }

      const [ordLockTxId, ordLockVoutStr] = String(listing.ordLockOutpoint).split('.');
      const ordLockVout = parseInt(ordLockVoutStr, 10);
      if (!ordLockTxId || Number.isNaN(ordLockVout)) {
        throw new Error('Invalid ordLockOutpoint format');
      }

      const ordLockTxData = await getTransactionByTxID(ordLockTxId);
      if (!ordLockTxData?.outputs?.[ordLockVout]?.beef) {
        throw new Error(`Could not find OrdLock transaction: ${ordLockTxId}`);
      }

      const ordLockBeef = ordLockTxData.outputs[ordLockVout].beef;
      const ordLockTransaction = Transaction.fromBEEF(ordLockBeef);

      const ordLock = new WalletOrdLock(wallet);
      const ordLockScript = Script.fromHex(listing.ordLockScript);
      const cancelUnlockTemplate = ordLock.cancelUnlock({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
        signOutputs: 'all',
        anyoneCanPay: false,
        sourceSatoshis: 1,
        lockingScript: ordLockScript,
      });
      const cancelUnlockingLength = await cancelUnlockTemplate.estimateLength();

      const ordinalP2PKH = new OrdinalsP2PKH();

      const returnItemData: Record<string, any> = listing.materialTokenId
        ? {
          materialTokenId: listing.materialTokenId,
          lootTableId: listing.lootTableId,
          itemName: listing.itemName,
          itemIcon: listing.itemIcon,
          itemType: listing.itemType,
          rarity: listing.rarity,
          tier: listing.tier,
          tokenId: listing.tokenId,
          transactionId: listing.transactionId,
          quantity: listing.quantity,
        }
        : {
          inventoryItemId: listing.inventoryItemId,
          lootTableId: listing.lootTableId,
          itemName: listing.itemName,
          itemIcon: listing.itemIcon,
          itemType: listing.itemType,
          rarity: listing.rarity,
          tier: listing.tier,
          tokenId: listing.tokenId,
          equipmentStats: listing.equipmentStats,
          crafted: listing.crafted,
          statRoll: listing.statRoll,
          isEmpowered: listing.isEmpowered,
          prefix: listing.prefix,
          suffix: listing.suffix,
        };

      const returnLockingScript = ordinalP2PKH.lock(
        publicKey,
        listing.assetId,
        returnItemData,
        'transfer'
      );

      const actionRes = await wallet.createAction({
        description: 'Cancelling marketplace listing',
        inputBEEF: ordLockBeef,
        inputs: [
          {
            inputDescription: 'OrdLock UTXO to cancel',
            outpoint: listing.ordLockOutpoint,
            unlockingScriptLength: cancelUnlockingLength,
          }
        ],
        outputs: [
          {
            outputDescription: 'Return item to seller',
            lockingScript: returnLockingScript.toHex(),
            satoshis: 1,
          }
        ],
        options: {
          randomizeOutputs: false,
          acceptDelayedBroadcast: false,
        }
      });

      if (!actionRes.signableTransaction) {
        throw new Error('Failed to create signable transaction');
      }

      const reference = actionRes.signableTransaction.reference;
      const txToSign = Transaction.fromBEEF(actionRes.signableTransaction.tx);
      txToSign.inputs[0].unlockingScriptTemplate = cancelUnlockTemplate;
      txToSign.inputs[0].sourceTransaction = ordLockTransaction;
      await txToSign.sign();

      const unlockingScript = txToSign.inputs[0].unlockingScript;
      if (!unlockingScript) {
        throw new Error('Missing unlocking script after signing');
      }

      const signed = await wallet.signAction({
        reference,
        spends: {
          '0': { unlockingScript: unlockingScript.toHex() }
        }
      });

      if (!signed.tx) {
        throw new Error('Failed to sign action');
      }

      const cancelTx = Transaction.fromAtomicBEEF(signed.tx);

      const returnVout = cancelTx.outputs.findIndex(
        o => (o.satoshis || 0) === 1 && o.lockingScript.toHex() === returnLockingScript.toHex()
      );

      if (returnVout < 0) {
        throw new Error('Could not locate return output');
      }

      const broadcast = await broadcastTX(cancelTx);
      const cancelTxId = broadcast.txid;
      if (!cancelTxId) {
        throw new Error('Failed to get transaction ID from broadcast');
      }

      const returnTokenId = `${cancelTxId}.${returnVout}`;

      const response = await fetch('/api/marketplace/cancel-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId: item._id,
          userPublicKey: publicKey,
          returnTokenId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to cancel listing');
      }

      toast.success(data.message, { id: loadingToast });
      onSuccess();
      onClose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to cancel listing';
      toast.error(errorMessage, { id: loadingToast });
    } finally {
      setProcessing(false);
    }
  };

  const handlePurchase = async () => {
    if (!wallet) {
      toast.error('Wallet not connected');
      return;
    }

    setProcessing(true);
    const loadingToast = toast.loading('Purchasing item...');

    try {
      const isAuthenticated = await wallet.isAuthenticated();
      if (!isAuthenticated) {
        throw new Error('Wallet not authenticated');
      }

      // Get user's public key
      const { publicKey: buyerPublicKey } = await wallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
      });

      // Fetch server identity key
      const serverPubKeyResponse = await fetch('/api/server-identity-key');
      if (!serverPubKeyResponse.ok) {
        throw new Error('Failed to fetch server identity key');
      }
      const { publicKey: serverIdentityKey } = await serverPubKeyResponse.json();

      console.log('Creating payment transaction for purchase...');

      // Calculate total payment (item price + network fees)
      const totalPayment = item.price + 100; // Add 100 sats for network fees

      // Create WalletP2PKH payment with derivation params
      const { paymentTx, paymentTxId, walletParams } = await createWalletPayment(
        wallet,
        serverIdentityKey,
        totalPayment,
        `Payment for marketplace purchase: ${item.itemName}`
      );

      console.log('Payment transaction created:', {
        txid: paymentTxId,
        satoshis: totalPayment,
        walletParams,
      });

      const response = await fetch('/api/marketplace/purchase-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId: item._id,
          buyerPublicKey,
          paymentTx,
          walletParams,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to purchase item');
      }

      toast.success(data.message, { id: loadingToast });
      onSuccess();
      onClose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to purchase item';
      toast.error(errorMessage, { id: loadingToast });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className={`bg-gradient-to-br ${getRarityColor(item.rarity)} rounded-2xl p-8 max-w-2xl w-full border-4 shadow-2xl`}>
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div className="flex items-center gap-4">
            <div className="text-6xl">{item.itemIcon}</div>
            <div>
              <h2 className="text-3xl font-bold text-white mb-1">
                {getItemDisplayName()}
              </h2>
              <p className="text-lg text-gray-300 capitalize">
                {item.rarity} {item.itemType}
                {item.tier && ` • Tier ${item.tier}`}
              </p>
              {(item.prefix || item.suffix) && (
                <p className="text-sm text-blue-400 mt-1">
                  {item.prefix && `🔷 ${item.prefix.name}`}
                  {item.prefix && item.suffix && ' • '}
                  {item.suffix && `🔶 ${item.suffix.name}`}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-4xl leading-none cursor-pointer"
          >
            ×
          </button>
        </div>

        {/* Item Details */}
        <div className="space-y-4 mb-6">
          {/* Price */}
          <div className="bg-black/30 rounded-lg p-4">
            <p className="text-gray-400 text-sm mb-1">Price</p>
            <p className="text-yellow-400 font-bold text-2xl">{item.price} satoshis</p>
          </div>

          {/* Seller */}
          <div className="bg-black/30 rounded-lg p-4">
            <p className="text-gray-400 text-sm mb-1">Seller</p>
            <p className="text-white font-semibold">{item.sellerUsername}</p>
            {isOwnListing && (
              <p className="text-green-400 text-xs mt-1">⭐ This is your listing</p>
            )}
          </div>

          {/* Quantity (for materials) */}
          {item.quantity && item.quantity > 1 && (
            <div className="bg-black/30 rounded-lg p-4">
              <p className="text-gray-400 text-sm mb-1">Quantity</p>
              <p className="text-white font-semibold">{item.quantity}</p>
            </div>
          )}

          {/* Equipment Stats */}
          {item.equipmentStats && Object.keys(item.equipmentStats).length > 0 && (
            <div className="bg-black/30 rounded-lg p-4">
              <p className="text-gray-400 text-sm mb-2">Equipment Stats</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(item.equipmentStats).map(([stat, value]) => (
                  <div key={stat} className="text-sm">
                    <span className="text-gray-300 capitalize">{stat.replace(/([A-Z])/g, ' $1')}: </span>
                    <span className="text-white font-semibold">{value}</span>
                  </div>
                ))}
              </div>
              {item.crafted && item.statRoll && (
                <p className="text-xs text-gray-400 mt-2">
                  Crafted with {(item.statRoll * 100).toFixed(0)}% stat roll
                </p>
              )}
              {item.isEmpowered && (
                <p className="text-xs text-purple-400 mt-1">⚡ Empowered by corrupted monster</p>
              )}
            </div>
          )}

          {/* Inscriptions */}
          {(item.prefix || item.suffix) && (
            <div className="bg-black/30 rounded-lg p-4">
              <p className="text-gray-400 text-sm mb-2">Inscriptions</p>
              {item.prefix && (
                <div className="mb-1">
                  <span className="text-blue-400 text-sm">Prefix: </span>
                  <span className="text-white text-sm font-semibold">{item.prefix.name}</span>
                </div>
              )}
              {item.suffix && (
                <div>
                  <span className="text-blue-400 text-sm">Suffix: </span>
                  <span className="text-white text-sm font-semibold">{item.suffix.name}</span>
                </div>
              )}
            </div>
          )}

          {/* Listed Date */}
          <div className="bg-black/30 rounded-lg p-4">
            <p className="text-gray-400 text-sm mb-1">Listed</p>
            <p className="text-white text-sm">
              {new Date(item.listedAt).toLocaleString()}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4">
          {isOwnListing ? (
            <>
              <button
                onClick={onClose}
                className="flex-1 px-6 py-4 bg-gray-700 hover:bg-gray-600 text-white font-bold rounded-lg transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={handleCancel}
                disabled={processing}
                className={`
                  flex-1 px-6 py-4 rounded-lg font-bold text-lg transition-all
                  ${!processing
                    ? 'bg-red-600 hover:bg-red-700 text-white shadow-lg cursor-pointer'
                    : 'bg-gray-700 text-gray-400 cursor-not-allowed'
                  }
                `}
              >
                {processing ? 'Cancelling...' : '🚫 Cancel Listing'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                className="flex-1 px-6 py-4 bg-gray-700 hover:bg-gray-600 text-white font-bold rounded-lg transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={handlePurchase}
                disabled={processing || !wallet}
                className={`
                  flex-1 px-6 py-4 rounded-lg font-bold text-lg transition-all
                  ${!processing && wallet
                    ? 'bg-green-600 hover:bg-green-700 text-white shadow-lg cursor-pointer'
                    : 'bg-gray-700 text-gray-400 cursor-not-allowed'
                  }
                `}
              >
                {processing ? 'Purchasing...' : `💰 Buy for ${item.price} sats`}
              </button>
            </>
          )}
        </div>

        {!wallet && !isOwnListing && (
          <p className="text-center text-red-400 text-sm mt-4">
            ⚠️ Connect wallet to purchase items
          </p>
        )}
      </div>
    </div>
  );
}

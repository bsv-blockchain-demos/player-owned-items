// Marketplace purchase: atomic claim (active -> pending) BEFORE any wallet work so only
// one concurrent buyer proceeds, then all wallet UTXO ops run through the serialized
// wallet queue. A wallet-block failure releases the claim back to 'active' (rollback) —
// this route is NOT best-effort like the other wallet routes; a stranded 'pending'
// listing must never be left behind. Post-broadcast DB mutations (listing -> sold,
// ownership transfer) run inside a single withTransaction for atomicity.

import { Router, type Request, type Response } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import { Beef, Transaction, Script, P2PKH, PublicKey, type AtomicBEEF } from '@bsv/sdk';
import { WalletOrdLock, WalletP2PKH } from '@bsv/wallet-helper';
import { requireAuthProof } from '@server/middleware/requireAuthProof';
import { requireSession } from '@server/middleware/requireSession';
import { getWalletQueue } from '@server/lib/walletQueue';
import { connectToMongo, getClient } from '@server/lib/mongodb';
import { getServerIdentityPublicKey } from '@server/lib/serverWallet';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { broadcastTX, getTransactionByTxID } from '@shared/overlayFunctions';
import { decodeBeef, encodeBeef } from '@shared/beefEncoding';
import { generateNonce, deriveRecipientKey } from '@shared/tokenDerivation';
import { getLootItemById, type LootItem, type EquipmentStats } from '@shared/loot-table';
import type { MarketplaceItem } from '@shared/types';
import { TOKEN_CLAIM_FAILED } from '@server/lib/materialUnits';

export const marketplaceRouter = Router();

marketplaceRouter.post('/purchase-listing', requireAuthProof('purchase'), async (req: Request, res: Response) => {
  const userId = req.userId as string;

  // Per-step timing to localize purchase latency (cumulative ms from request start).
  const t0 = Date.now();
  const step = (label: string) => console.log(`[marketplace:purchase] ${label} +${Date.now() - t0}ms`);

  const { listingId, buyerIdentityKey, paymentTx, walletParams } = req.body;

  if (!listingId || !buyerIdentityKey || !paymentTx || !walletParams) {
    res.status(400).json({ error: 'Missing required fields: listingId, buyerIdentityKey, paymentTx, walletParams' });
    return;
  }

  const { marketplaceItemsCollection, marketplaceListingBeefsCollection, userInventoryCollection, materialTokensCollection, usersCollection } = await connectToMongo();

  const listingObjectId = new ObjectId(listingId);

  // Atomically claim the listing before any wallet work, so only one concurrent buyer proceeds.
  const claimed = await marketplaceItemsCollection.findOneAndUpdate(
    { _id: listingObjectId, status: 'active' },
    { $set: { status: 'pending', pendingBuyerId: userId, pendingAt: new Date() } },
    { returnDocument: 'after' },
  );

  if (!claimed) {
    res.status(409).json({ error: 'Listing is not available' });
    return;
  }

  const listing = claimed;

  // Releases a claimed listing back to active; used on any failure after the claim so it's never stranded in 'pending'.
  const releaseListing = async () => {
    await marketplaceItemsCollection.updateOne(
      { _id: listingObjectId, status: 'pending', pendingBuyerId: userId },
      { $set: { status: 'active' }, $unset: { pendingBuyerId: '', pendingAt: '' } },
    );
  };

  // Can't buy your own listing
  if (listing.sellerId === userId) {
    await releaseListing();
    res.status(400).json({ error: 'You cannot purchase your own listing' });
    return;
  }

  // Ensure listing has OrdLock data
  if (!listing.ordLockOutpoint || !listing.ordLockScript || !listing.assetId || !listing.payAddress) {
    await releaseListing();
    res.status(400).json({ error: 'Listing is missing OrdLock data' });
    return;
  }

  // Parse payment transaction (client sends base64 BEEF) + validate it's sufficient —
  // moved before the wallet lock so an insufficient payment never enters the queue.
  // Wrapped in its own try/catch: the claim already flipped the listing to 'pending',
  // so ANY throw here (e.g. malformed paymentTx) must still release it — otherwise a
  // single bad request strands the listing in 'pending' forever (per-listing DoS).
  let paymentBeef: number[];
  let paymentTransaction: Transaction;
  let paymentOutpoint: string;
  const feeBufferSatoshis = 100;
  const requiredPayment = listing.price + feeBufferSatoshis;
  try {
    paymentBeef = decodeBeef(paymentTx);
    paymentTransaction = Transaction.fromBEEF(paymentBeef);
    const paymentTxId = paymentTransaction.id('hex');
    const paymentOutput = paymentTransaction.outputs[0];
    if (!paymentOutput || (paymentOutput.satoshis ?? 0) < requiredPayment) {
      await releaseListing();
      res.status(400).json({ error: `Invalid payment amount. Required: ${requiredPayment} sats (price ${listing.price} + ${feeBufferSatoshis} sats fees)` });
      return;
    }
    paymentOutpoint = `${paymentTxId}.0`;
  } catch (err) {
    await releaseListing();
    res.status(400).json({ error: 'Invalid payment transaction' });
    return;
  }
  step('validated + payment parsed');

  // ===== CREATE PURCHASE TRANSACTION =====
  // Wallet build + sign + broadcast; any failure here releases the claim back to 'active'.
  let purchaseResult: {
    action: { tx?: AtomicBEEF };
    txid: string;
    buyerTokenId: string;
    purchaseNonce: string;
    serverIdentityKey: string;
  };
  try {
    purchaseResult = await (await getWalletQueue()).enqueue('purchase', async (serverWallet) => {
      // Resolve the listing tx: DB backup first, overlay as fallback.
      const [ordLockTxId, ordLockVoutStr] = String(listing.ordLockOutpoint).split('.');
      const beefDoc = await marketplaceListingBeefsCollection.findOne({ listingId });
      let ordLockTransaction: Transaction;
      if (beefDoc?.beef) {
        ordLockTransaction = Transaction.fromBEEF(decodeBeef(beefDoc.beef));
      } else {
        const ordLockTxData = await getTransactionByTxID(ordLockTxId);
        const overlayBeef = ordLockTxData?.outputs?.[parseInt(ordLockVoutStr, 10)]?.beef;
        if (!overlayBeef) {
          throw new Error('Listing tx not found in DB backup or overlay');
        }
        ordLockTransaction = Transaction.fromBEEF(overlayBeef);
      }
      const ordLockScript = Script.fromHex(listing.ordLockScript!);

      // Create purchase unlock template
      const ordLock = new WalletOrdLock();
      const purchaseUnlockTemplate = ordLock.purchaseUnlock({
        sourceSatoshis: 1,
        lockingScript: ordLockScript,
      });

      // Derive recipient key for output 0 (token to buyer)
      const purchaseNonce = generateNonce();
      const serverIdentityKey = await getServerIdentityPublicKey();
      const buyerKey = await deriveRecipientKey(serverWallet, buyerIdentityKey, purchaseNonce);

      // Create transfer locking script (item to buyer, locked to derived key)
      const ordinalP2PKH = new OrdinalsP2PKH();
      const transferLockingScript = ordinalP2PKH.lock(
        buyerKey,
        listing.assetId!,
        listing, // Item metadata
        'transfer',
      );

      // Create payment locking script (payment to seller)
      // This MUST match the payout in OrdLock (address and amount)
      const sellerPaymentScript = new P2PKH().lock(listing.payAddress!);

      // Create unlocking templates for payment input
      const walletp2pkh = new WalletP2PKH(serverWallet);
      const paymentUnlockTemplate = walletp2pkh.unlock({
        protocolID: walletParams.protocolID,
        keyID: walletParams.keyID,
        counterparty: walletParams.counterparty,
      });
      const paymentUnlockingLength = await paymentUnlockTemplate.estimateLength();

      // Build outputs array
      const outputs: Array<{ outputDescription: string; lockingScript: string; satoshis: number }> = [
        {
          outputDescription: 'Transfer item to buyer',
          lockingScript: transferLockingScript.toHex(),
          satoshis: 1,
        },
        {
          outputDescription: 'Payment to seller',
          lockingScript: sellerPaymentScript.toHex(),
          satoshis: listing.price,
        },
      ];

      const mergedBeef = new Beef();
      mergedBeef.mergeBeef(ordLockTransaction.toBEEF());
      mergedBeef.mergeBeef(paymentBeef);
      const inputBEEF = mergedBeef.toBinary();

      // STEP 1: createAction - Prepare transaction
      // OrdLock purchase unlocking script length depends on the final transaction outputs,
      // so we do a quick two-pass createAction: first with a conservative placeholder,
      // then compute the exact length from the signable transaction and recreate.
      const ordLockUnlockingLengthPlaceholder = 400;
      let actionRes = await serverWallet.createAction({
        description: 'Purchasing marketplace item',
        inputBEEF,
        inputs: [
          {
            inputDescription: 'OrdLock UTXO to purchase',
            outpoint: listing.ordLockOutpoint!,
            unlockingScriptLength: ordLockUnlockingLengthPlaceholder,
          },
          {
            inputDescription: 'Buyer payment for item and fees',
            outpoint: paymentOutpoint,
            unlockingScriptLength: paymentUnlockingLength,
          },
        ],
        outputs,
        options: {
          randomizeOutputs: false,
          acceptDelayedBroadcast: false,
        },
      });

      if (!actionRes.signableTransaction) {
        throw new Error('Failed to create signable transaction');
      }

      const txForLength = Transaction.fromBEEF(actionRes.signableTransaction.tx);
      const ordLockUnlockingLength = await purchaseUnlockTemplate.estimateLength(txForLength, 0);
      const ordLockUnlockingLengthWithBuffer = ordLockUnlockingLength + 68;

      actionRes = await serverWallet.createAction({
        description: 'Purchasing marketplace item',
        inputBEEF,
        inputs: [
          {
            inputDescription: 'OrdLock UTXO to purchase',
            outpoint: listing.ordLockOutpoint!,
            unlockingScriptLength: ordLockUnlockingLengthWithBuffer,
          },
          {
            inputDescription: 'Buyer payment for item and fees',
            outpoint: paymentOutpoint,
            unlockingScriptLength: paymentUnlockingLength,
          },
        ],
        outputs,
        options: {
          randomizeOutputs: false,
          acceptDelayedBroadcast: false,
        },
      });

      if (!actionRes.signableTransaction) {
        throw new Error('Failed to create signable transaction');
      }
      step('createAction done');

      // STEP 2: Sign - Generate unlocking scripts
      const reference = actionRes.signableTransaction.reference;
      const txToSign = Transaction.fromBEEF(actionRes.signableTransaction.tx);

      // Attach templates and source transactions
      txToSign.inputs[0].unlockingScriptTemplate = purchaseUnlockTemplate;
      txToSign.inputs[0].sourceTransaction = ordLockTransaction;
      txToSign.inputs[1].unlockingScriptTemplate = paymentUnlockTemplate;
      txToSign.inputs[1].sourceTransaction = paymentTransaction;

      // Sign the transaction (this generates the OrdLock purchase unlocking script)
      await txToSign.sign();
      step('local sign done');

      // Extract unlocking scripts
      const ordLockUnlockingScript = txToSign.inputs[0].unlockingScript;
      const paymentUnlockingScript = txToSign.inputs[1].unlockingScript;

      if (!ordLockUnlockingScript || !paymentUnlockingScript) {
        throw new Error('Missing unlocking scripts after signing');
      }

      // STEP 3: signAction - Finalize transaction
      const action = await serverWallet.signAction({
        reference,
        spends: {
          '0': { unlockingScript: ordLockUnlockingScript.toHex() },
          '1': { unlockingScript: paymentUnlockingScript.toHex() },
        },
      });

      if (!action.tx) {
        throw new Error('Failed to sign action');
      }
      step('signAction done — token ready, overlay push fired off-path');

      // Derive the txid locally from the signed tx — this IS what broadcastTX would
      // report (it also just computes tx.id('hex')), so no need to await the overlay
      // push here. The overlay push now happens off-path, after the response is sent.
      const tx = Transaction.fromAtomicBEEF(action.tx);
      const txid = tx.id('hex');

      if (!txid) {
        throw new Error('Failed to derive transaction ID from signed tx');
      }

      const buyerTokenId = `${txid}.0`;

      return { action, txid, buyerTokenId, purchaseNonce, serverIdentityKey };
    });
  } catch (err) {
    await releaseListing();
    console.error('Purchase failed, listing released:', err);
    res.status(502).json({ error: 'Purchase failed; listing released' });
    return;
  }

  const { action, txid, buyerTokenId, purchaseNonce, serverIdentityKey } = purchaseResult;

  // ===== FINALIZE (post-broadcast DB mutations, atomic) =====
  const client = await getClient();
  const dbSession = client.startSession();
  try {
    await dbSession.withTransaction(async () => {
      // Update marketplace listing status (only if still claimed by this buyer)
      await marketplaceItemsCollection.updateOne(
        { _id: listingObjectId, status: 'pending' },
        {
          $set: {
            status: 'sold',
            soldAt: new Date(),
            soldTo: userId,
            payoutOutpoint: `${txid}.1`, // output 1 = seller payment (claimable proceeds)
          },
          $unset: { pendingBuyerId: '', pendingAt: '' },
        },
        { session: dbSession },
      );

      // Listing spent — drop the BEEF backup.
      await marketplaceListingBeefsCollection.deleteOne({ listingId }, { session: dbSession });

      // Get buyer user info
      const buyerUser = await usersCollection.findOne({ userId }, { session: dbSession });
      if (!buyerUser) {
        throw new Error('Buyer user not found');
      }

      // Transfer item ownership in database
      if (listing.inventoryItemId) {
        // Transfer inventory item to buyer
        await userInventoryCollection.updateOne(
          { _id: new ObjectId(listing.inventoryItemId) },
          {
            $set: {
              userId: userId, // New owner
              tokenId: buyerTokenId,
              keyId: purchaseNonce,
              counterparty: serverIdentityKey,
              updatedAt: new Date(),
            },
          },
          { session: dbSession },
        );
      } else if (listing.materialTokenId) {
        // Transfer material token to buyer
        await materialTokensCollection.updateOne(
          { _id: new ObjectId(listing.materialTokenId) },
          {
            $set: {
              userId: userId, // New owner
              tokenId: buyerTokenId,
              keyId: purchaseNonce,
              counterparty: serverIdentityKey,
              updatedAt: new Date(),
            },
          },
          { session: dbSession },
        );
      }
    });
  } finally {
    await dbSession.endSession();
  }
  step('db written');

  res.json({
    success: true,
    buyerTokenId,
    message: `${listing.itemName} purchased for ${listing.price} satoshis`,
    transferBeef: encodeBeef(Array.from(action.tx!)),
    received: {
      outputIndex: 0,
      keyId: purchaseNonce,
      counterparty: serverIdentityKey,
      tags: [listing.materialTokenId ? 'type:material' : 'type:item'],
    },
  });

  // Fire-and-forget overlay push, off the response path and outside the wallet
  // queue lock. The token is already on-chain (signAction); this only speeds up
  // overlay-based lookups.
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(action.tx!)))
    .catch((e) => {
      console.error('[marketplace:purchase] overlay broadcast failed (non-blocking):', e);
    });
});

// Fetch the requester's sold listings that have a claimable payout outpoint (sold-items inbox).
marketplaceRouter.get('/my-sales', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;

    const { marketplaceItemsCollection } = await connectToMongo();

    const sales = await marketplaceItemsCollection
      .find({
        sellerId: userId,
        status: 'sold',
        payoutOutpoint: { $exists: true },
      })
      .sort({ soldAt: -1 })
      .toArray();

    const formattedSales = sales.map(doc => ({
      _id: doc._id?.toString(),
      itemName: doc.itemName,
      itemIcon: doc.itemIcon,
      rarity: doc.rarity,
      price: doc.price,
      payoutOutpoint: doc.payoutOutpoint,
      listingNonce: doc.listingNonce,
      payoutClaimed: !!doc.payoutClaimed,
      soldAt: doc.soldAt,
    }));

    res.json({
      success: true,
      sales: formattedSales,
      count: formattedSales.length,
    });
  } catch (error) {
    console.error('Error fetching my-sales:', error);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// Fetch a single marketplace listing (seller-only) including OrdLock details.
marketplaceRouter.get('/listing/:id', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;

    const listingId = req.params.id;
    if (!listingId) {
      res.status(400).json({ error: 'Missing listing id' });
      return;
    }

    const { marketplaceItemsCollection, marketplaceListingBeefsCollection } = await connectToMongo();

    const listing = await marketplaceItemsCollection.findOne({
      _id: new ObjectId(listingId),
      status: 'active',
    });

    if (!listing) {
      res.status(404).json({ error: 'Listing not found or not active' });
      return;
    }

    if (listing.sellerId !== userId) {
      res.status(403).json({ error: 'You are not the seller of this listing' });
      return;
    }

    // Attach the listing tx BEEF so the seller can spend the orderLock on cancel
    // without the overlay (client falls back to overlay if this is missing).
    const beefDoc = await marketplaceListingBeefsCollection.findOne({ listingId });

    res.json({
      success: true,
      listing: {
        ...listing,
        _id: listing._id?.toString(),
        ordLockBeef: beefDoc?.beef,
      },
    });
  } catch (error) {
    console.error('Error fetching marketplace listing:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch listing' });
  }
});

// Fetch marketplace items with filters (public browse endpoint).
marketplaceRouter.get('/items', async (req: Request, res: Response) => {
  try {
    // Extract filter parameters
    const search = (req.query.search as string) || '';
    const itemType = (req.query.itemType as string) || '';
    const rarity = (req.query.rarity as string) || '';
    const tier = (req.query.tier as string) || '';
    const minPrice = (req.query.minPrice as string) || '';
    const maxPrice = (req.query.maxPrice as string) || '';

    const { marketplaceItemsCollection } = await connectToMongo();

    // Build query
    const query: Filter<MarketplaceItem> = { status: 'active' };

    // Regex search on item name (case-insensitive)
    if (search) {
      query.itemName = { $regex: search, $options: 'i' } as any;
    }

    // Filter by item type
    if (itemType) {
      query.itemType = itemType as any;
    }

    // Filter by rarity
    if (rarity) {
      query.rarity = rarity as any;
    }

    // Filter by tier
    if (tier) {
      const tierNum = parseInt(tier, 10);
      if (!isNaN(tierNum)) {
        query.tier = tierNum;
      }
    }

    // Filter by price range
    if (minPrice || maxPrice) {
      const priceFilter: { $gte?: number; $lte?: number } = {};
      if (minPrice) {
        const minPriceNum = parseInt(minPrice, 10);
        if (!isNaN(minPriceNum)) {
          priceFilter.$gte = minPriceNum;
        }
      }
      if (maxPrice) {
        const maxPriceNum = parseInt(maxPrice, 10);
        if (!isNaN(maxPriceNum)) {
          priceFilter.$lte = maxPriceNum;
        }
      }
      query.price = priceFilter as any;
    }

    // Fetch marketplace items (sorted by newest first)
    const items = await marketplaceItemsCollection
      .find(query)
      .sort({ listedAt: -1 })
      .limit(100) // Limit to 100 items for performance
      .toArray();

    // Format items for frontend
    const formattedItems = items.map(item => ({
      _id: item._id?.toString(),
      sellerId: item.sellerId,
      sellerUsername: item.sellerUsername,
      lootTableId: item.lootTableId,
      itemName: item.itemName,
      itemIcon: item.itemIcon,
      itemType: item.itemType,
      rarity: item.rarity,
      tier: item.tier,
      tokenId: item.tokenId,
      transactionId: item.transactionId,
      quantity: item.quantity,
      price: item.price,
      listedAt: item.listedAt,
      equipmentStats: item.equipmentStats,  // Base stats from loot table
      crafted: item.crafted,                 // Crafted status
      statRoll: item.statRoll,               // Frontend calculates: stats * statRoll
      isEmpowered: item.isEmpowered,         // Corrupted monster bonus
      prefix: item.prefix,
      suffix: item.suffix,
    }));

    res.json({
      success: true,
      items: formattedItems,
      count: formattedItems.length,
    });
  } catch (error) {
    console.error('Error fetching marketplace items:', error);
    res.status(500).json({ error: 'Failed to fetch marketplace items' });
  }
});

// List an item (NFT or material token) for sale on the marketplace.
// Validates client-created OrdLock transaction and persists the listing.
marketplaceRouter.post('/list-item', requireAuthProof('list'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;
    const body = req.body;

    const { inventoryItemId, materialTokenId, price, userPublicKey, listingNonce, ordLockOutpoint, ordLockScript, ordLockBeef } = body;

    // Validate price
    if (!price || isNaN(price) || price <= 0) {
      res.status(400).json({ error: 'Valid price is required' });
      return;
    }

    // Must provide either inventoryItemId or materialTokenId (not both)
    if ((!inventoryItemId && !materialTokenId) || (inventoryItemId && materialTokenId)) {
      res.status(400).json({ error: 'Must provide either inventoryItemId or materialTokenId' });
      return;
    }

    // Validate required fields for on-chain listing
    if (!userPublicKey || !ordLockOutpoint || !ordLockScript) {
      res.status(400).json({ error: 'Missing required fields: userPublicKey, ordLockOutpoint, ordLockScript' });
      return;
    }

    // Stored canonical (lowercase) so crafting/merging can't miss a listing by id case.
    const materialTokenHex = materialTokenId ? new ObjectId(materialTokenId).toHexString() : undefined;
    const inventoryItemHex = inventoryItemId ? new ObjectId(inventoryItemId).toHexString() : undefined;

    const {
      usersCollection,
      nftLootCollection,
      userInventoryCollection,
      materialTokensCollection,
      marketplaceItemsCollection,
      marketplaceListingBeefsCollection
    } = await connectToMongo();

    // Get user info
    const user = await usersCollection.findOne({ userId });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Generate seller address from public key (for both cancel and payment)
    const payAddress = PublicKey.fromString(userPublicKey).toAddress();
    const cancelAddress = payAddress;

    interface ItemData {
      inventoryItemId?: string;
      materialTokenId?: string;
      lootTableId: string;
      itemName: string;
      itemIcon: string;
      itemType: 'weapon' | 'armor' | 'consumable' | 'material' | 'artifact' | 'inscription_scroll' | 'spell_scroll';
      rarity: 'common' | 'rare' | 'epic' | 'legendary';
      tier: number;
      tokenId?: string;
      transactionId?: string;
      quantity?: number;
      equipmentStats?: EquipmentStats;
      crafted?: boolean;
      statRoll?: number;
      isEmpowered?: boolean;
      prefix?: any;
      suffix?: any;
    }

    let itemData: ItemData | null = null;
    let lootItem: LootItem | undefined;
    let currentTokenId: string | undefined;
    let assetId: string | undefined;

    if (inventoryItemId) {
      // Listing an NFT item from inventory
      const item = await userInventoryCollection.findOne({
        _id: new ObjectId(inventoryItemId),
        userId
      });

      if (!item) {
        res.status(404).json({ error: 'Item not found in inventory' });
        return;
      }

      // Item must be minted (have nftLootId and tokenId)
      if (!item.nftLootId || !item.tokenId) {
        res.status(400).json({ error: 'Item must be minted as NFT before listing' });
        return;
      }

      // A craft is spending it.
      if (item.pendingClaim) {
        res.status(409).json({ error: TOKEN_CLAIM_FAILED });
        return;
      }

      // Check if already listed
      const existingListing = await marketplaceItemsCollection.findOne({
        inventoryItemId: inventoryItemHex,
        status: 'active'
      });

      if (existingListing) {
        res.status(400).json({ error: 'Item is already listed on marketplace' });
        return;
      }

      lootItem = getLootItemById(item.lootTableId);
      if (!lootItem) {
        res.status(404).json({ error: 'Item data not found' });
        return;
      }

      currentTokenId = item.tokenId; // txid.vout format
      assetId = item.mintOutpoint?.replace('.', '_'); // txid_vout format

      itemData = {
        inventoryItemId: inventoryItemHex,
        lootTableId: item.lootTableId,
        itemName: lootItem.name,
        itemIcon: lootItem.icon,
        itemType: lootItem.type,
        rarity: lootItem.rarity,
        tier: item.tier,
        tokenId: currentTokenId,
        equipmentStats: lootItem.equipmentStats,
        crafted: item.crafted,
        statRoll: item.statRoll,
        isEmpowered: item.isEmpowered,
        prefix: item.prefix,
        suffix: item.suffix,
      };

    } else if (materialTokenId) {
      // Listing a material token
      const token = await materialTokensCollection.findOne({
        _id: new ObjectId(materialTokenId),
        userId
      });

      if (!token) {
        res.status(404).json({ error: 'Material token not found' });
        return;
      }

      // Token must not be consumed
      if (token.consumed) {
        res.status(400).json({ error: 'Material token has been consumed' });
        return;
      }

      // A craft or merge is spending it.
      if (token.pendingClaim) {
        res.status(409).json({ error: TOKEN_CLAIM_FAILED });
        return;
      }

      // Check if already listed
      const existingListing = await marketplaceItemsCollection.findOne({
        materialTokenId: materialTokenHex,
        status: 'active'
      });

      if (existingListing) {
        res.status(400).json({ error: 'Material is already listed on marketplace' });
        return;
      }

      lootItem = getLootItemById(token.lootTableId);
      if (!lootItem) {
        res.status(404).json({ error: 'Material data not found' });
        return;
      }

      currentTokenId = token.tokenId; // txid.vout format
      assetId = token.mintOutpoint?.replace('.', '_'); // txid_vout format

      const tokenMetadata = token.metadata as { tier?: number } | undefined;
      const tier = tokenMetadata?.tier || 1;

      const derivedTransactionId = token.lastTransactionId || token.tokenId?.split('.')[0];

      itemData = {
        materialTokenId: materialTokenHex,
        lootTableId: token.lootTableId,
        itemName: lootItem.name,
        itemIcon: lootItem.icon,
        itemType: lootItem.type,
        rarity: lootItem.rarity,
        tier: tier,
        tokenId: currentTokenId,
        transactionId: derivedTransactionId,
        quantity: token.quantity,
      };
    }

    // Ensure itemData and tokenId are valid
    if (!itemData || !currentTokenId || !assetId) {
      res.status(500).json({ error: 'Failed to prepare item data or missing tokenId' });
      return;
    }

    // ===== VALIDATE CLIENT-CREATED ORDLOCK TRANSACTION (ON-CHAIN) =====
    // Recompute the expected OrdLock locking script and verify it matches the
    // client-provided script and the actual transaction output.
    const ordLock = new WalletOrdLock();
    const expectedOrdLockScript = await ordLock.lock({
      ordAddress: cancelAddress,
      payAddress,
      price: parseInt(price, 10),
      assetId,
      itemData,
      metadata: { app: "monsterbattle", type: "ord" },
    });

    if (expectedOrdLockScript.toHex() !== ordLockScript) {
      res.status(400).json({ error: 'ordLockScript does not match expected script for this item/price/userPublicKey' });
      return;
    }

    const [ordLockTxId, ordLockVoutStr] = String(ordLockOutpoint).split('.');
    const ordLockVout = parseInt(ordLockVoutStr, 10);
    if (!ordLockTxId || Number.isNaN(ordLockVout)) {
      res.status(400).json({ error: 'Invalid ordLockOutpoint format' });
      return;
    }

    // Validate from the client-posted BEEF
    if (!ordLockBeef) {
      res.status(400).json({ error: 'Missing ordLockBeef' });
      return;
    }
    const listingTx = Transaction.fromBEEF(decodeBeef(ordLockBeef));

    const hasTokenInput = listingTx.inputs.some((i: any) => {
      const inTxid = i.sourceTXID || i.sourceTransaction?.id('hex');
      return `${inTxid}.${i.sourceOutputIndex}` === currentTokenId;
    });

    if (!hasTokenInput) {
      res.status(400).json({ error: 'Listing transaction does not spend the expected tokenId for this user/item' });
      return;
    }

    const output = listingTx.outputs[ordLockVout];
    if (!output || (output.satoshis || 0) !== 1) {
      res.status(400).json({ error: 'OrdLock output must be 1 satoshi' });
      return;
    }

    if (output.lockingScript.toHex() !== ordLockScript) {
      res.status(400).json({ error: 'OrdLock output script does not match ordLockScript' });
      return;
    }

    // Create marketplace listing with OrdLock data
    const marketplaceItem = {
      sellerId: userId,
      sellerUsername: user.username,
      ...itemData,
      tokenId: ordLockOutpoint,
      price: parseInt(price, 10),
      ordLockOutpoint: ordLockOutpoint,
      ordLockScript: ordLockScript,
      payAddress: payAddress,
      assetId: assetId,
      listingNonce: listingNonce, // nonce to re-derive the per-listing cancel/payout key
      status: 'active' as const,
      listedAt: new Date(),
    };

    let result;
    try {
      result = await marketplaceItemsCollection.insertOne(marketplaceItem);
    } catch (e: any) {
      // Partial unique index rejected a concurrent duplicate active listing
      if (e?.code === 11000) {
        res.status(400).json({ error: 'Item is already listed on marketplace' });
        return;
      }
      throw e;
    }

    // Back up the listing tx BEEF for overlay-independent spends.
    await marketplaceListingBeefsCollection.insertOne({
      listingId: result.insertedId.toString(),
      ordLockOutpoint,
      beef: ordLockBeef,
      createdAt: new Date(),
    });

    if (inventoryItemId) {
      const item = await userInventoryCollection.findOne({ _id: new ObjectId(inventoryItemId), userId });
      const { modifiedCount } = await userInventoryCollection.updateOne(
        { _id: new ObjectId(inventoryItemId), userId, tokenId: currentTokenId, pendingClaim: { $exists: false } },
        {
          $set: {
            tokenId: ordLockOutpoint,
            updatedAt: new Date(),
          }
        }
      );
      // Claimed by a craft since it was read: that request owns the item.
      if (modifiedCount !== 1) {
        await marketplaceItemsCollection.deleteOne({ _id: result.insertedId });
        await marketplaceListingBeefsCollection.deleteOne({ listingId: result.insertedId.toString() });
        res.status(409).json({ error: TOKEN_CLAIM_FAILED });
        return;
      }

      if (item?.nftLootId) {
        await nftLootCollection.updateOne(
          { _id: item.nftLootId },
          {
            $set: {
              tokenId: ordLockOutpoint,
              updatedAt: new Date(),
            }
          }
        );
      }
    } else if (materialTokenId) {
      const { modifiedCount } = await materialTokensCollection.updateOne(
        { _id: new ObjectId(materialTokenId), userId, tokenId: currentTokenId, pendingClaim: { $exists: false } },
        {
          $set: {
            previousTokenId: currentTokenId,
            tokenId: ordLockOutpoint,
            updatedAt: new Date(),
          }
        }
      );
      // Claimed by a craft or merge since it was read: that request owns the token.
      if (modifiedCount !== 1) {
        await marketplaceItemsCollection.deleteOne({ _id: result.insertedId });
        await marketplaceListingBeefsCollection.deleteOne({ listingId: result.insertedId.toString() });
        res.status(409).json({ error: TOKEN_CLAIM_FAILED });
        return;
      }
    }

    res.json({
      success: true,
      listingId: result.insertedId.toString(),
      ordLockOutpoint,
      message: `${itemData.itemName} listed for ${price} satoshis`,
    });

  } catch (error) {
    console.error('Error listing item on marketplace:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list item' });
  }
});

// Cancel a marketplace listing and return the item to the seller.
// Uses OrdLock.cancelListing() to unlock the orderLock UTXO.
marketplaceRouter.post('/cancel-listing', requireAuthProof('cancel'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;
    const body = req.body;

    const { listingId, returnTokenId, cancelBeef, keyId, counterparty } = body;

    // Validate required fields
    if (!listingId || !returnTokenId) {
      res.status(400).json({ error: 'Missing required fields: listingId, returnTokenId' });
      return;
    }

    const { marketplaceItemsCollection, marketplaceListingBeefsCollection, userInventoryCollection, materialTokensCollection, nftLootCollection } = await connectToMongo();

    // Fetch the listing
    const listing = await marketplaceItemsCollection.findOne({
      _id: new ObjectId(listingId),
      status: 'active'
    });

    if (!listing) {
      res.status(404).json({ error: 'Listing not found or already cancelled/sold' });
      return;
    }

    // Verify user is the seller
    if (listing.sellerId !== userId) {
      res.status(403).json({ error: 'You are not the seller of this listing' });
      return;
    }

    // Ensure listing has OrdLock data
    if (!listing.ordLockOutpoint || !listing.ordLockScript || !listing.assetId) {
      res.status(400).json({ error: 'Listing is missing OrdLock data' });
      return;
    }

    const [cancelTxId, returnVoutStr] = String(returnTokenId).split('.');
    const returnVout = parseInt(returnVoutStr, 10);
    if (!cancelTxId || Number.isNaN(returnVout)) {
      res.status(400).json({ error: 'Invalid returnTokenId format' });
      return;
    }

    // Validate from the client-posted BEEF
    if (!cancelBeef) {
      res.status(400).json({ error: 'Missing cancelBeef' });
      return;
    }
    const cancelTx = Transaction.fromBEEF(decodeBeef(cancelBeef));

    const spendsOrdLock = cancelTx.inputs.some((i: any) => {
      const inTxid = i.sourceTXID || i.sourceTransaction?.id('hex');
      return `${inTxid}.${i.sourceOutputIndex}` === listing.ordLockOutpoint;
    });

    if (!spendsOrdLock) {
      res.status(400).json({ error: 'Cancel transaction does not spend the listing ordLockOutpoint' });
      return;
    }

    const output = cancelTx.outputs[returnVout];
    if (!output || (output.satoshis || 0) !== 1) {
      res.status(400).json({ error: 'Cancel transaction return output must be 1 satoshi' });
      return;
    }

    // Update marketplace listing status
    await marketplaceItemsCollection.updateOne(
      { _id: new ObjectId(listingId) },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          tokenId: returnTokenId,
        }
      }
    );

    // Listing spent — drop the BEEF backup.
    await marketplaceListingBeefsCollection.deleteOne({ listingId });

    // Update item tokenId in inventory or material tokens
    if (listing.inventoryItemId) {
      const inv = await userInventoryCollection.findOne({ _id: new ObjectId(listing.inventoryItemId), userId });
      await userInventoryCollection.updateOne(
        { _id: new ObjectId(listing.inventoryItemId) },
        {
          $set: {
            tokenId: returnTokenId,
            keyId,
            counterparty,
            updatedAt: new Date(),
          }
        }
      );

      if (inv?.nftLootId) {
        await nftLootCollection.updateOne(
          { _id: inv.nftLootId },
          {
            $set: {
              tokenId: returnTokenId,
              keyId,
              counterparty,
              updatedAt: new Date(),
            }
          }
        );
      }
    } else if (listing.materialTokenId) {
      await materialTokensCollection.updateOne(
        { _id: new ObjectId(listing.materialTokenId) },
        {
          $set: {
            tokenId: returnTokenId,
            keyId,
            counterparty,
            updatedAt: new Date(),
          }
        }
      );
    }

    res.json({
      success: true,
      returnTokenId,
      message: `${listing.itemName} listing cancelled`,
    });

  } catch (error) {
    console.error('Error cancelling listing:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to cancel listing' });
  }
});

// Record that the seller has claimed (internalized) the payout for a sold listing.
// The on-chain internalize happens client-side; this only flips payoutClaimed so the
// inbox can hide/distinguish already-claimed sales.
marketplaceRouter.post('/claim-proceeds', requireAuthProof('claim'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;
    const body = req.body;

    const { listingId } = body;

    if (!listingId) {
      res.status(400).json({ error: 'Missing required field: listingId' });
      return;
    }

    const { marketplaceItemsCollection } = await connectToMongo();

    const listing = await marketplaceItemsCollection.findOne({
      _id: new ObjectId(listingId),
    });

    if (!listing) {
      res.status(404).json({ error: 'Listing not found' });
      return;
    }

    if (listing.sellerId !== userId) {
      res.status(403).json({ error: 'You are not the seller of this listing' });
      return;
    }

    if (listing.status !== 'sold') {
      res.status(400).json({ error: 'Listing is not sold' });
      return;
    }

    await marketplaceItemsCollection.updateOne(
      { _id: new ObjectId(listingId) },
      { $set: { payoutClaimed: true } }
    );

    res.json({ success: true });

  } catch (error) {
    console.error('Error claiming proceeds:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to claim proceeds' });
  }
});

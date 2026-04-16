import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { getLootItemById, LootItem, EquipmentStats } from '@/lib/loot-table';
import { WalletOrdLock } from '@bsv/wallet-helper';
import { Transaction, PublicKey } from '@bsv/sdk';
import { getTransactionByTxID } from '@/utils/overlayFunctions';

/**
 * POST /api/marketplace/list-item
 * List an item (NFT or material token) for sale on the marketplace
 * Validates client-created OrdLock transaction and persists listing
 */
export async function POST(request: NextRequest) {
  try {
    // Get cookies using next/headers
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    const userId = payload.userId as string;

    const body = await request.json();
    const { inventoryItemId, materialTokenId, price, userPublicKey, ordLockOutpoint, ordLockScript } = body;

    // Validate price
    if (!price || isNaN(price) || price <= 0) {
      return NextResponse.json({ error: 'Valid price is required' }, { status: 400 });
    }

    // Must provide either inventoryItemId or materialTokenId (not both)
    if ((!inventoryItemId && !materialTokenId) || (inventoryItemId && materialTokenId)) {
      return NextResponse.json(
        { error: 'Must provide either inventoryItemId or materialTokenId' },
        { status: 400 }
      );
    }

    // Validate required fields for on-chain listing
    if (!userPublicKey || !ordLockOutpoint || !ordLockScript) {
      return NextResponse.json(
        { error: 'Missing required fields: userPublicKey, ordLockOutpoint, ordLockScript' },
        { status: 400 }
      );
    }

    const {
      usersCollection,
      nftLootCollection,
      userInventoryCollection,
      materialTokensCollection,
      marketplaceItemsCollection
    } = await connectToMongo();

    // Get user info
    const user = await usersCollection.findOne({ userId });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Generate seller address from public key (for both cancel and payment)
    const payAddress = PublicKey.fromString(userPublicKey).toAddress();
    const cancelAddress = payAddress

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
        return NextResponse.json({ error: 'Item not found in inventory' }, { status: 404 });
      }

      // Item must be minted (have nftLootId and tokenId)
      if (!item.nftLootId || !item.tokenId) {
        return NextResponse.json(
          { error: 'Item must be minted as NFT before listing' },
          { status: 400 }
        );
      }

      // Check if already listed
      const existingListing = await marketplaceItemsCollection.findOne({
        inventoryItemId: inventoryItemId,
        status: 'active'
      });

      if (existingListing) {
        return NextResponse.json(
          { error: 'Item is already listed on marketplace' },
          { status: 400 }
        );
      }

      lootItem = getLootItemById(item.lootTableId);
      if (!lootItem) {
        return NextResponse.json({ error: 'Item data not found' }, { status: 404 });
      }

      currentTokenId = item.tokenId; // txid.vout format
      assetId = item.mintOutpoint?.replace('.', '_'); // txid_vout format

      itemData = {
        inventoryItemId: inventoryItemId,
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
        return NextResponse.json({ error: 'Material token not found' }, { status: 404 });
      }

      // Token must not be consumed
      if (token.consumed) {
        return NextResponse.json(
          { error: 'Material token has been consumed' },
          { status: 400 }
        );
      }

      // Check if already listed
      const existingListing = await marketplaceItemsCollection.findOne({
        materialTokenId: materialTokenId,
        status: 'active'
      });

      if (existingListing) {
        return NextResponse.json(
          { error: 'Material is already listed on marketplace' },
          { status: 400 }
        );
      }

      lootItem = getLootItemById(token.lootTableId);
      if (!lootItem) {
        return NextResponse.json({ error: 'Material data not found' }, { status: 404 });
      }

      currentTokenId = token.tokenId; // txid.vout format
      assetId = token.mintOutpoint?.replace('.', '_'); // txid_vout format

      const tokenMetadata = token.metadata as { tier?: number } | undefined;
      const tier = tokenMetadata?.tier || 1;

      const derivedTransactionId = token.lastTransactionId || token.tokenId?.split('.')[0];

      itemData = {
        materialTokenId: materialTokenId,
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
      return NextResponse.json(
        { error: 'Failed to prepare item data or missing tokenId' },
        { status: 500 }
      );
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
      return NextResponse.json(
        { error: 'ordLockScript does not match expected script for this item/price/userPublicKey' },
        { status: 400 }
      );
    }

    const [ordLockTxId, ordLockVoutStr] = String(ordLockOutpoint).split('.');
    const ordLockVout = parseInt(ordLockVoutStr, 10);
    if (!ordLockTxId || Number.isNaN(ordLockVout)) {
      return NextResponse.json(
        { error: 'Invalid ordLockOutpoint format' },
        { status: 400 }
      );
    }

    const listingTxData = await getTransactionByTxID(ordLockTxId);
    if (!listingTxData?.outputs?.[ordLockVout]?.beef) {
      return NextResponse.json(
        { error: `Could not find listing transaction: ${ordLockTxId}` },
        { status: 400 }
      );
    }

    const listingTx = Transaction.fromBEEF(listingTxData.outputs[ordLockVout].beef);

    const hasTokenInput = listingTx.inputs.some(i => {
      const inTxid = i.sourceTXID || i.sourceTransaction?.id('hex');
      return `${inTxid}.${i.sourceOutputIndex}` === currentTokenId;
    });

    if (!hasTokenInput) {
      return NextResponse.json(
        { error: 'Listing transaction does not spend the expected tokenId for this user/item' },
        { status: 400 }
      );
    }

    const output = listingTx.outputs[ordLockVout];
    if (!output || (output.satoshis || 0) !== 1) {
      return NextResponse.json(
        { error: 'OrdLock output must be 1 satoshi' },
        { status: 400 }
      );
    }

    if (output.lockingScript.toHex() !== ordLockScript) {
      return NextResponse.json(
        { error: 'OrdLock output script does not match ordLockScript' },
        { status: 400 }
      );
    }

    console.log(' [LIST-ITEM] Validated OrdLock script and outpoint:', {
      payAddress,
      price: parseInt(price, 10),
      assetId,
      ordLockOutpoint,
    });

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
      status: 'active' as const,
      listedAt: new Date(),
    };

    const result = await marketplaceItemsCollection.insertOne(marketplaceItem);

    if (inventoryItemId) {
      const item = await userInventoryCollection.findOne({ _id: new ObjectId(inventoryItemId), userId });
      await userInventoryCollection.updateOne(
        { _id: new ObjectId(inventoryItemId), userId },
        {
          $set: {
            tokenId: ordLockOutpoint,
            updatedAt: new Date(),
          }
        }
      );

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
      await materialTokensCollection.updateOne(
        { _id: new ObjectId(materialTokenId), userId },
        {
          $set: {
            previousTokenId: currentTokenId,
            tokenId: ordLockOutpoint,
            updatedAt: new Date(),
          }
        }
      );
    }

    console.log('[MARKETPLACE LIST] Item listed with OrdLock:', {
      listingId: result.insertedId,
      itemName: itemData.itemName,
      price: price,
      ordLockOutpoint,
    });

    return NextResponse.json({
      success: true,
      listingId: result.insertedId.toString(),
      ordLockOutpoint,
      message: `${itemData.itemName} listed for ${price} satoshis`,
    });

  } catch (error) {
    console.error('Error listing item on marketplace:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list item' },
      { status: 500 }
    );
  }
}

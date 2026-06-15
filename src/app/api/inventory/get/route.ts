import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';
import { getLootItemById } from '@/lib/loot-table';

export async function GET(request: NextRequest) {
  try {
    // Get cookies using next/headers
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const userId = payload.userId as string;

    // Validate that userId exists in the payload
    if (!userId) {
      console.error('JWT payload missing userId:', payload);
      return NextResponse.json({ error: 'Invalid token: missing userId' }, { status: 401 });
    }

    // Check query parameters
    const { searchParams } = new URL(request.url);
    const mintedOnly = searchParams.get('mintedOnly') === 'true';
    const excludeListed = searchParams.get('excludeListed') === 'true';

    // Ensure MongoDB is connected and get collections
    const { userInventoryCollection, nftLootCollection, materialTokensCollection, marketplaceItemsCollection } = await connectToMongo();

    // Items with an active listing are escrowed in an orderLock and not sellable again
    const listedInventoryIds = new Set<string>();
    const listedMaterialIds = new Set<string>();
    if (excludeListed) {
      const activeListings = await marketplaceItemsCollection
        .find({ sellerId: userId, status: 'active' })
        .toArray();
      for (const l of activeListings) {
        if (l.inventoryItemId) listedInventoryIds.add(l.inventoryItemId);
        if (l.materialTokenId) listedMaterialIds.add(l.materialTokenId);
      }
    }

    // Build query for inventory items
    const inventoryQuery: any = { userId };
    if (mintedOnly) {
      // Only return items that have been minted (have nftLootId)
      inventoryQuery.nftLootId = { $exists: true, $ne: null };
    }

    // Fetch inventory items for this user
    const inventoryItems = (await userInventoryCollection
      .find(inventoryQuery)
      .sort({ acquiredAt: -1 }) // Most recent first
      .toArray())
      .filter(item => !listedInventoryIds.has(item._id!.toString()));

    // Build query for material tokens
    const materialTokenQuery: any = { userId, consumed: { $ne: true } };
    if (mintedOnly) {
      // Only return material tokens that have been minted (have tokenId)
      materialTokenQuery.tokenId = { $exists: true, $ne: null };
    }

    // Fetch material tokens for this user (minted materials with quantity)
    const materialTokens = (await materialTokensCollection
      .find(materialTokenQuery)
      .toArray())
      .filter(token => !listedMaterialIds.has(token._id!.toString()));

    // Build inventory by getting loot data from loot-table
    const inventory = inventoryItems.map((inventoryItem) => {
      // Get base item data from loot-table
      const lootTemplate = getLootItemById(inventoryItem.lootTableId);
      if (!lootTemplate) return null;

      return {
        lootId: inventoryItem.lootTableId,
        name: lootTemplate.name,
        icon: lootTemplate.icon,
        description: lootTemplate.description,
        rarity: lootTemplate.rarity,
        type: lootTemplate.type,
        tier: inventoryItem.tier, // Which tier this item dropped from (1-5)
        acquiredAt: inventoryItem.acquiredAt,
        sessionId: inventoryItem.fromSessionId?.toString(),
        inventoryId: inventoryItem._id?.toString(),
        nftLootId: inventoryItem.nftLootId?.toString(), // Will be undefined if not minted yet
        tokenId: inventoryItem.tokenId, // Current token location (from UserInventory)
        mintOutpoint: inventoryItem.mintOutpoint, // Original mint proof
        borderGradient: inventoryItem.borderGradient, // User-specific gradient colors
        isMinted: !!inventoryItem.nftLootId, // True if NFT has been created
        crafted: inventoryItem.crafted, // True if item was crafted
        statRoll: inventoryItem.statRoll, // Stat roll multiplier (0.8 to 1.2) for crafted items
        isEmpowered: inventoryItem.isEmpowered, // True if from corrupted monster (+20% stats)
        equipmentStats: lootTemplate.equipmentStats, // Include equipment stats for display
        prefix: inventoryItem.prefix,
        suffix: inventoryItem.suffix,
        enhanced: inventoryItem.enhanced || false,
        keyId: inventoryItem.keyId,
        counterparty: inventoryItem.counterparty,
      };
    }).filter(item => item !== null); // Filter out any items not found

    // For minted items, fetch the NFT details to get mint transaction ID
    const mintedItemIds = inventoryItems
      .filter(item => item.nftLootId)
      .map(item => item.nftLootId!);

    if (mintedItemIds.length > 0) {
      const nftLootItems = await nftLootCollection
        .find({ _id: { $in: mintedItemIds } })
        .toArray();

      const nftLootMap = new Map(
        nftLootItems.map(item => [item._id!.toString(), item])
      );

      // Add mint/current transaction info to minted items
      inventory.forEach((item: any) => {
        if (item.nftLootId) {
          const nftLoot = nftLootMap.get(item.nftLootId);
          if (nftLoot) {
            // Extract txid from mintOutpoint (format: "txid.vout")
            item.mintTransactionId = nftLoot.mintOutpoint?.split('.')[0];

			// Ensure mintOutpoint is always present for minted items.
			// Older records may not have had mintOutpoint copied onto UserInventory.
			if (!item.mintOutpoint && nftLoot.mintOutpoint) {
				item.mintOutpoint = nftLoot.mintOutpoint;
			}

            // Provide current token location (full outpoint format: txid.vout)
            item.tokenId = nftLoot.tokenId; // Current location on blockchain
            item.currentTokenId = nftLoot.tokenId; // Backward compatibility
          }
        }
      });
    }

    // Add material tokens to inventory (minted materials with quantity)
    const materialTokenItems = materialTokens.map((token) => {
      const lootTemplate = getLootItemById(token.lootTableId);
      if (!lootTemplate) return null;

      // Extract tier from metadata if available, default to 1
      const tier = (token.metadata as any)?.tier || 1;

      // Extract transaction ID from tokenId (format: "txid.vout")
      // Use lastTransactionId if available (from updates), otherwise extract from tokenId
      let transactionId: string | undefined;
      if (token.lastTransactionId) {
        transactionId = token.lastTransactionId;
      } else if (token.tokenId) {
        transactionId = token.tokenId.split('.')[0];
      }

      // Also extract mint transaction ID from mintOutpoint
      const mintTransactionId = token.mintOutpoint?.split('.')[0];

      return {
        lootId: token.lootTableId,
        name: lootTemplate.name,
        icon: lootTemplate.icon,
        description: lootTemplate.description,
        rarity: lootTemplate.rarity,
        type: lootTemplate.type, // Should be 'material'
        tier: tier,
        acquiredAt: token.createdAt, // Use token creation date
        inventoryId: token._id?.toString(), // For backward compatibility with UI
        materialTokenId: token._id?.toString(), // Specific to material tokens
        nftLootId: undefined, // Material tokens don't use NFTLoot collection
        tokenId: token.tokenId, // Blockchain token ID (full outpoint)
        transactionId: transactionId, // Extracted transaction ID (just txid)
        mintTransactionId: mintTransactionId, // Original mint txid
        mintOutpoint: token.mintOutpoint, // Original mint proof (full outpoint)
        borderGradient: undefined, // Materials don't have gradients
        isMinted: !!token.tokenId, // True if on blockchain
        quantity: token.quantity, // Material token quantity
        isMaterialToken: true,
        crafted: false,
        statRoll: undefined,
        isEmpowered: false,
        equipmentStats: undefined,
        prefix: undefined,
        suffix: undefined,
        enhanced: false,
        keyId: token.keyId,
        counterparty: token.counterparty,
      };
    }).filter(item => item !== null);

    // Combine regular inventory with material tokens
    const combinedInventory = [...inventory, ...materialTokenItems];

    return NextResponse.json({
      success: true,
      inventory: combinedInventory,
      totalItems: combinedInventory.length
    });

  } catch (error) {
    console.error('Error fetching inventory:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inventory' },
      { status: 500 }
    );
  }
}

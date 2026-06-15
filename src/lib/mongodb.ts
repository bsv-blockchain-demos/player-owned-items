import { MongoClient, ServerApiVersion, Db, Collection, Document } from 'mongodb';
import type { User, NFTLoot, UserInventory, BattleSession, PlayerStats, MaterialToken, MarketplaceItem, MarketplaceListingBeef, BattleHistory } from './types';

// Extract database name from URI
function getDatabaseNameFromUri(connectionUri: string): string {
  try {
    // Parse the URI to extract the database name
    const url = new URL(connectionUri.replace('mongodb+srv://', 'http://').replace('mongodb://', 'http://'));
    const dbName = url.pathname.slice(1).split('?')[0]; // Remove leading '/' and query params

    if (!dbName) {
      throw new Error('Database name not found in MONGODB_URI. Please include the database name in the connection string (e.g., mongodb+srv://user:pass@cluster.mongodb.net/supplychain)');
    }

    return dbName;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Database name not found')) {
      throw error;
    }
    throw new Error('Failed to parse MONGODB_URI. Please ensure it is a valid MongoDB connection string with a database name.');
  }
}

// Lazy initialization - only get env vars when actually connecting
function getMongoConfig() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not defined in environment variables');
  }
  const dbName = getDatabaseNameFromUri(uri);
  return { uri, dbName };
}

// Connection options with pooling configuration
const options = {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 10, // Maximum number of connections in the pool
  minPoolSize: 2,  // Minimum number of connections to maintain
  maxIdleTimeMS: 30000, // Close connections that have been idle for 30 seconds
};

// Client will be initialized on first connection
let client: MongoClient | null = null;

let clientPromise: Promise<MongoClient>;

// Collection names
export const COLLECTIONS = {
  USERS: 'users',
  NFT_LOOT: 'nft_loot',
  USER_INVENTORY: 'user_inventory',
  BATTLE_SESSIONS: 'battle_sessions',
  BATTLE_HISTORY: 'battle_history',
  PLAYER_STATS: 'player_stats',
  MATERIAL_TOKENS: 'material_tokens',
  MARKETPLACE_ITEMS: 'marketplace_items',
  MARKETPLACE_LISTING_BEEFS: 'marketplace_listing_beefs',
} as const;

// Database and collections cache
let db: Db | null = null;
let usersCollection: Collection<User> | null = null;
let nftLootCollection: Collection<NFTLoot> | null = null;
let userInventoryCollection: Collection<UserInventory> | null = null;
let battleSessionsCollection: Collection<BattleSession> | null = null;
let battleHistoryCollection: Collection<BattleHistory> | null = null;
let playerStatsCollection: Collection<PlayerStats> | null = null;
let materialTokensCollection: Collection<MaterialToken> | null = null;
let marketplaceItemsCollection: Collection<MarketplaceItem> | null = null;
let marketplaceListingBeefsCollection: Collection<MarketplaceListingBeef> | null = null;
let collectionsInitialized = false;

// Promise to handle concurrent connection attempts
let connectingPromise: Promise<void> | null = null;

// Connect to MongoDB and initialize collections
async function connectToMongo() {
  // Get configuration
  const { uri, dbName } = getMongoConfig();

  // Return immediately if already connected
  if (db && collectionsInitialized) {
    return {
      db: db!,
      usersCollection: usersCollection!,
      nftLootCollection: nftLootCollection!,
      userInventoryCollection: userInventoryCollection!,
      battleSessionsCollection: battleSessionsCollection!,
      battleHistoryCollection: battleHistoryCollection!,
      playerStatsCollection: playerStatsCollection!,
      materialTokensCollection: materialTokensCollection!,
      marketplaceItemsCollection: marketplaceItemsCollection!,
      marketplaceListingBeefsCollection: marketplaceListingBeefsCollection!
    };
  }

  // If already connecting, wait for that connection
  if (connectingPromise) {
    await connectingPromise;
    return {
      db: db!,
      usersCollection: usersCollection!,
      nftLootCollection: nftLootCollection!,
      userInventoryCollection: userInventoryCollection!,
      battleSessionsCollection: battleSessionsCollection!,
      battleHistoryCollection: battleHistoryCollection!,
      playerStatsCollection: playerStatsCollection!,
      materialTokensCollection: materialTokensCollection!,
      marketplaceItemsCollection: marketplaceItemsCollection!,
      marketplaceListingBeefsCollection: marketplaceListingBeefsCollection!
    };
  }

  // Start connection process
  connectingPromise = (async () => {
    try {
      // Initialize client if not already done
      if (!client) {
        client = new MongoClient(uri, options);
        await client.connect();
        console.log("Connected to MongoDB!");
      } else {
        // Reuse existing client if already connected
        console.log("Reusing existing MongoDB connection");
      }

      // Initialize database with explicit name
      db = client.db(dbName);

      // Get typed collection handles
      usersCollection = db.collection<User>(COLLECTIONS.USERS);
      nftLootCollection = db.collection<NFTLoot>(COLLECTIONS.NFT_LOOT);
      userInventoryCollection = db.collection<UserInventory>(COLLECTIONS.USER_INVENTORY);
      battleSessionsCollection = db.collection<BattleSession>(COLLECTIONS.BATTLE_SESSIONS);
      battleHistoryCollection = db.collection<BattleHistory>(COLLECTIONS.BATTLE_HISTORY);
      playerStatsCollection = db.collection<PlayerStats>(COLLECTIONS.PLAYER_STATS);
      materialTokensCollection = db.collection<MaterialToken>(COLLECTIONS.MATERIAL_TOKENS);
      marketplaceItemsCollection = db.collection<MarketplaceItem>(COLLECTIONS.MARKETPLACE_ITEMS);
      marketplaceListingBeefsCollection = db.collection<MarketplaceListingBeef>(COLLECTIONS.MARKETPLACE_LISTING_BEEFS);

      // Only create indexes once (not on every connection)
      if (!collectionsInitialized) {
        console.log("Initializing MongoDB indexes...");

        async function safeCreateIndex<T extends Document>(
          collection: Collection<T>,
          indexSpec: any,
          options?: any
        ) {
          try {
            await collection.createIndex(indexSpec, options);
          } catch (error: any) {
            if (error?.code === 86 || error?.codeName === 'IndexKeySpecsConflict') {
              const indexName =
                options?.name ||
                Object.keys(indexSpec)
                  .map((k) => `${k}_${indexSpec[k]}`)
                  .join('_');
              try {
                await collection.dropIndex(indexName);
                await collection.createIndex(indexSpec, options);
              } catch (dropError) {
                throw dropError;
              }
              return;
            }
            throw error;
          }
        }

        // Create indexes for better performance
        // Using Promise.all for parallel index creation
        await Promise.all([
          // Users indexes
          safeCreateIndex(usersCollection, { userId: 1 }, { unique: true }),
          usersCollection.createIndex({ username: 1 }),

          // NFT Loot indexes
          nftLootCollection.createIndex({ rarity: 1 }),
          nftLootCollection.createIndex({ lootTableId: 1 }),
          nftLootCollection.createIndex({ mintOutpoint: 1 }, {
            partialFilterExpression: { mintOutpoint: { $exists: true } }
          }),

          // User Inventory indexes
          userInventoryCollection.createIndex({ userId: 1 }),
          userInventoryCollection.createIndex({ lootTableId: 1 }),
          userInventoryCollection.createIndex({ nftLootId: 1 }, {
            partialFilterExpression: { nftLootId: { $exists: true } }
          }),
          userInventoryCollection.createIndex({ userId: 1, acquiredAt: -1 }),
          userInventoryCollection.createIndex({ fromMonsterId: 1 }),

          // Battle Sessions indexes
          battleSessionsCollection.createIndex({ userId: 1, startedAt: -1 }),
          battleSessionsCollection.createIndex({ userId: 1, isDefeated: 1 }),
          battleSessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

          // Battle History indexes
          safeCreateIndex(battleHistoryCollection, { sessionId: 1 }, { unique: true }),
          battleHistoryCollection.createIndex({ userId: 1, createdAt: -1 }),

          // Player Stats indexes
          playerStatsCollection.createIndex({ userId: 1 }, { unique: true }),
          playerStatsCollection.createIndex({ level: 1 }),
          playerStatsCollection.createIndex({ currentZone: 1, currentTier: 1 }),

          // Material Tokens indexes
          materialTokensCollection.createIndex({ userId: 1 }),
          materialTokensCollection.createIndex({ lootTableId: 1 }),
          materialTokensCollection.createIndex({ userId: 1, lootTableId: 1, tier: 1 }), // Compound index for check-token query
          safeCreateIndex(materialTokensCollection, { tokenId: 1 }, { unique: true }), // Unique blockchain token ID
          materialTokensCollection.createIndex({ consumed: 1 }),

          // Marketplace Items indexes
          marketplaceItemsCollection.createIndex({ sellerId: 1 }),
          marketplaceItemsCollection.createIndex({ status: 1 }),
          marketplaceItemsCollection.createIndex({ status: 1, listedAt: -1 }), // Active listings by date
          marketplaceItemsCollection.createIndex({ itemType: 1, status: 1 }), // Filter by type
          marketplaceItemsCollection.createIndex({ rarity: 1, status: 1 }), // Filter by rarity
          marketplaceItemsCollection.createIndex({ tier: 1, status: 1 }), // Filter by tier
          marketplaceItemsCollection.createIndex({ itemName: 1 }), // Regular index for name search

          // At most one active listing per item (partial: only indexes active listings)
          safeCreateIndex(
            marketplaceItemsCollection,
            { inventoryItemId: 1 },
            { unique: true, partialFilterExpression: { status: 'active', inventoryItemId: { $exists: true } } }
          ),
          safeCreateIndex(
            marketplaceItemsCollection,
            { materialTokenId: 1 },
            { unique: true, partialFilterExpression: { status: 'active', materialTokenId: { $exists: true } } }
          ),

          // Marketplace listing BEEF backups, keyed by listingId
          safeCreateIndex(marketplaceListingBeefsCollection, { listingId: 1 }, { unique: true }),
        ]);

        collectionsInitialized = true;
        console.log("✅ MongoDB indexes created successfully");
      }

      console.log(`✅ MongoDB connected to database: ${dbName}`);
    } catch (error) {
      console.error("❌ Error connecting to MongoDB:", error);
      // Reset state on error
      db = null;
      collectionsInitialized = false;
      throw error;
    } finally {
      // Clear the connecting promise
      connectingPromise = null;
    }
  })();

  // Wait for connection to complete
  await connectingPromise;

  return {
    db: db!,
    usersCollection: usersCollection!,
    nftLootCollection: nftLootCollection!,
    userInventoryCollection: userInventoryCollection!,
    battleSessionsCollection: battleSessionsCollection!,
    battleHistoryCollection: battleHistoryCollection!,
    playerStatsCollection: playerStatsCollection!,
    materialTokensCollection: materialTokensCollection!,
    marketplaceItemsCollection: marketplaceItemsCollection!,
    marketplaceListingBeefsCollection: marketplaceListingBeefsCollection!
  };
}

// Export connection function
export { connectToMongo };

// Helper function to get database (for backward compatibility)
export async function getDatabase(): Promise<Db> {
  const { db } = await connectToMongo();
  return db;
}

// Export collection getters (lazy initialization)
export async function getUsersCollection() {
  const { usersCollection } = await connectToMongo();
  return usersCollection;
}

export async function getMonstersCollection() {
  throw new Error('Monsters collection is no longer used. Monster snapshots are stored on battle sessions.');
}

export async function getNftLootCollection() {
  const { nftLootCollection } = await connectToMongo();
  return nftLootCollection;
}

export async function getUserInventoryCollection() {
  const { userInventoryCollection } = await connectToMongo();
  return userInventoryCollection;
}

export async function getBattleSessionsCollection() {
  const { battleSessionsCollection } = await connectToMongo();
  return battleSessionsCollection;
}

export async function getPlayerStatsCollection() {
  const { playerStatsCollection } = await connectToMongo();
  return playerStatsCollection;
}

export async function getMaterialTokensCollection() {
  const { materialTokensCollection } = await connectToMongo();
  return materialTokensCollection;
}

export async function getMarketplaceItemsCollection() {
  const { marketplaceItemsCollection } = await connectToMongo();
  return marketplaceItemsCollection;
}

export async function getClient() {
  if (!client) {
    throw new Error('MongoDB client not initialized');
  }
  return client;
}

// Graceful shutdown handler (for development)
if (process.env.NODE_ENV === 'development') {
  process.on('SIGINT', async () => {
    try {
      if (client) {
        await client.close();
        console.log('🔌 MongoDB connection closed (SIGINT)');
      }
      process.exit(0);
    } catch (error) {
      console.error('Error closing MongoDB connection:', error);
      process.exit(1);
    }
  });
}

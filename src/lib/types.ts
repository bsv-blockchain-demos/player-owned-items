import { ObjectId } from 'mongodb';
import { BiomeId, Tier } from './biome-config';
import { EquipmentStats } from './loot-table';

// ========== MongoDB Documents (Backend) ==========

// User document
export interface User {
  _id?: ObjectId;
  userId: string; // Unique user identifier (from external auth)
  username: string;
  createdAt: Date;
  updatedAt: Date;
}

// Monster document
export interface Monster {
  _id?: ObjectId;
  name: string;
  imageUrl: string; // URL or path to monster PNG
  clicksRequired: number; // Number of clicks needed to defeat (scaled by tier)
  attackDamage: number; // Damage per second dealt to player (scaled by tier)
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  biome: BiomeId; // Which biome this monster belongs to
  tier: Tier; // Which tier this monster instance is at
  moveInterval: number; // Time in milliseconds between position changes (700-3000ms)
  isBoss?: boolean; // True for boss monsters (enables phase system)
  isCorrupted?: boolean; // True for corrupted monsters (+50% HP, +25% damage, drops empowered items)
  dotEffect?: DebuffEffect; // Optional DoT effect on attack
  buffs?: MonsterBuff[]; // Monster buffs (Shield, Fast, etc.)
  specialAttacks?: SpecialAttack[]; // Boss special attacks (fireball, etc.)
  bossPhases?: BossPhase[]; // Boss phase system (for multi-phase bosses)
  createdAt: Date;
}

// NFT Loot document
export interface NFTLoot {
  _id?: ObjectId;
  lootTableId: string;  // Reference to loot-table.ts lootId (e.g. "dragon_scale")
  name: string;
  description: string;
  icon: string;         // Emoji icon
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  type: 'weapon' | 'armor' | 'consumable' | 'material' | 'artifact' | 'spell_scroll' | 'inscription_scroll';
  attributes?: Record<string, any>; // Custom NFT attributes (supports nested objects like borderGradient)
  mintOutpoint?: string; // Server mint outpoint (txid.vout) - proves item was minted by server
  tokenId?: string;      // Current token location (outpoint) - updated after transfers
  userId?: string;       // User who owns this NFT (for equipment updates)
  createdAt: Date;
}

export type ItemType = 'weapon' | 'armor' | 'consumable' | 'material' | 'artifact' | 'spell_scroll' | 'inscription_scroll';

// ========== Inscription System (Equipment Customization Phase 1) ==========

// Inscription types map to equipment stats
export type InscriptionType =
  | 'damage'      // +damageBonus
  | 'critical'    // +critChance
  | 'protection'  // +hpReduction
  | 'vitality'    // +maxHpBonus
  | 'haste'       // +attackSpeed
  | 'fortune'     // +coinBonus
  | 'healing'     // +healBonus
  | 'lifesteal'   // +lifesteal (offensive, legendary only, boss drops)
  | 'defensiveLifesteal'  // +defensiveLifesteal (defensive, legendary only, boss drops)
  | 'thorns'      // +thorns (defensive reflect, legendary only, boss drops)
  | 'autoclick';  // +autoClickRate (legendary only, boss drops)

// Inscription data structure (stored in loot-table.ts for inscription scrolls)
export interface InscriptionData {
  inscriptionType: InscriptionType;
  statValue: number; // 3, 5, 8, 12 (normal), or special values for lifesteal/autoclick
  slot: 'prefix' | 'suffix';
  name: string; // "Savage", "of Fury", etc.
  description: string; // "Adds +5 damage to equipment"
}

// Inscription applied to equipment (stored in UserInventory)
export interface Inscription {
  type: InscriptionType;
  value: number;
  name: string;
}

// User Inventory document
export interface UserInventory {
  _id?: ObjectId;
  userId: string;          // Reference to User.userId
  lootTableId: string;     // Reference to loot-table.ts lootId (e.g. "dragon_scale")
  itemType: ItemType;
  nftLootId?: ObjectId;    // Reference to NFTLoot._id (null until user mints it)
  tier: Tier;              // Which tier this item dropped from (1-5)
  borderGradient: { color1: string; color2: string }; // User-specific gradient (stored here, not in NFT until minted)
  acquiredAt: Date;
  fromMonsterId?: ObjectId; // Reference to Monster._id (undefined for crafted items)
  fromSessionId?: ObjectId; // Reference to BattleSession._id (undefined for crafted items)
  crafted?: boolean;        // True if item was crafted
  statRoll?: number;        // Stat roll multiplier (0.8 to 1.2) for crafted items
  rolledStats?: {           // Final stats after applying stat roll
    damageBonus?: number;
    critChance?: number;
    defense?: number;
    maxHpBonus?: number;
    attackSpeed?: number;
    coinBonus?: number;
  };
  isEmpowered?: boolean;    // True if dropped by a corrupted monster (+20% to all stats)

  // Blockchain token tracking
  tokenId?: string;         // Current token location (outpoint: "txid.vout") after transfers
  mintOutpoint?: string;    // Original server mint proof (outpoint: "txid.vout")

  // Equipment Customization (Phase 1: Inscriptions)
  prefix?: Inscription;     // Prefix inscription (e.g., "Savage" +5 damage)
  suffix?: Inscription;     // Suffix inscription (e.g., "of Haste" +5 attack speed)

  // Consumable Enhancement System
  enhanced?: boolean;       // True if consumable is enhanced (infinite uses with cooldown)

  // Consumption tracking (for materials/equipment consumed in crafting or updates)
  // NOTE: Not used for consumables - regular consumables can't be minted, enhanced are infinite
  consumed?: boolean;       // True if item was consumed (materials in crafting, equipment/scrolls in updates)
  consumedAt?: Date;        // When item was consumed
  consumedInRecipe?: string; // Recipe ID if consumed in crafting
  consumedInUpdate?: {       // Details if consumed in equipment update (flexible for different types)
    [key: string]: any;      // Allow any fields (newInventoryItemId, newTokenId, etc.)
  };
  updatedAt?: Date;         // Last update timestamp
}

// Player Stats document (RPG progression)
export interface PlayerStats {
  _id?: ObjectId;
  userId: string; // Reference to User.userId
  level: number;
  experience: number;
  coins: number;
  maxHealth: number;
  currentHealth: number;

  // Equipment slots (single object containing all equipment)
  equippedItems?: {
    weapon?: ObjectId;
    armor?: ObjectId;
    accessory1?: ObjectId;
    accessory2?: ObjectId;
  };
  equippedConsumables?: [ObjectId | 'empty', ObjectId | 'empty', ObjectId | 'empty', ObjectId | 'empty']; // Array of 4 ('empty' for empty slots) - Enables complex loadout strategies
  equippedSpell?: ObjectId | 'empty'; // Phase 2.6: Spell scroll slot (Q key)
  lastSpellCast?: number; // Phase 2.6: Server-side spell cooldown tracking (timestamp in ms)

  // Legacy fields (deprecated, kept for migration)
  equippedWeapon?: ObjectId;
  equippedArmor?: ObjectId;
  equippedAccessory1?: ObjectId;
  equippedAccessory2?: ObjectId;

  // Battle stats
  baseDamage: number;
  critChance: number;
  attackSpeed: number;

  // Progress tracking
  currentZone: number;
  currentTier: number;
  unlockedZones: string[]; // Array of "zone-tier" strings like "forest-1", "desert-1"

  // Statistics
  stats: {
    battlesWon: number;
    battlesWonStreak: number; // Legacy global win streak (deprecated, use battlesWonStreaks)
    monstersDefeated: number;
    bossesDefeated: number;
    totalDamageDealt: number;
    itemsCollected: number;
    legendariesFound: number;

    // Per-zone streak tracking (5 biomes × 5 tiers = 25 independent streaks)
    battlesWonStreaks?: {
      forest: number[];
      desert: number[];
      ocean: number[];
      volcano: number[];
      castle: number[];
    };
  };

  // Challenge Mode Configuration (Phase 3.3)
  battleChallengeConfig?: {
    forceShield: boolean;       // Force all monsters to spawn with shield
    forceSpeed: boolean;        // Force all monsters to spawn with speed challenge
    damageMultiplier: number;   // Monster damage multiplier (1.0, 1.25, 1.5, 2.0, 3.0)
    hpMultiplier: number;       // Monster HP multiplier (1.0, 1.5, 2.0, 3.0, 5.0)
    dotIntensity: number;       // DoT effect multiplier (1.0, 1.5, 2.0, 3.0, 5.0)
    corruptionRate: number;     // Force corruption rate (0, 0.25, 0.5, 0.75, 1.0)
    escapeTimerSpeed: number;   // Escape timer speed multiplier (1.0, 1.5, 2.0, 3.0, 4.0) - 10s minimum
    buffStrength: number;       // Monster buff strength multiplier (1.0, 1.5, 2.0, 3.0, 5.0)
    bossAttackSpeed: number;    // Boss attack cooldown multiplier (1.0, 0.75, 0.5, 0.33, 0.25)
    bossSpawnRate: number;      // Boss spawn rate multiplier (1.0 = normal, 5.0 = 5x bosses, -4 loot cards, +10% boss HP/DMG)
    skillshotCircles: number;   // Extra skillshot circles (0, +1, +2, +3, +4)
    skillshotSpeed: number;     // Skillshot speed multiplier (1.0, 0.9, 0.8, 0.7, 0.6) - affects circleDuration
  };

  createdAt: Date;
  lastBattleAt?: Date;
}

export interface BattleMonsterSnapshot {
  templateName: string;
  name: string;
  imageUrl: string; // URL or path to monster PNG
  clicksRequired: number; // Number of clicks needed to defeat (scaled by tier)
  attackDamage: number; // Damage per second dealt to player (scaled by tier)
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  biome: BiomeId; // Which biome this monster belongs to
  tier: Tier; // Which tier this monster instance is at
  moveInterval: number; // Time in milliseconds between position changes (700-3000ms)
  isBoss?: boolean; // True for boss monsters (enables phase system)
  isCorrupted?: boolean; // True for corrupted monsters (+50% HP, +25% damage, drops empowered items)
  dotEffect?: DebuffEffect; // Optional DoT effect on attack
  buffs?: MonsterBuff[]; // Monster buffs (Shield, Fast, etc.)
  specialAttacks?: SpecialAttack[]; // Boss special attacks (fireball, etc.)
  bossPhases?: BossPhase[]; // Boss phase system (for multi-phase bosses)
  createdAt: Date;
}

// Battle Session document
export interface BattleSession {
  _id?: ObjectId;
  userId: string; // Reference to User.userId
  biome: BiomeId; // Which biome this battle is in
  tier: Tier; // Which tier this battle is at
  monsterTemplateName: string;
  monster: BattleMonsterSnapshot;
  clickCount: number;
  isDefeated: boolean;
  lootOptions?: string[]; // Array of lootIds from loot-table (the 5 options shown)
  selectedLootId?: string; // The lootId the user chose, or 'SKIPPED' if user skipped loot selection
  usedItems: Record<string, number>; // Track items used during battle (for HP verification)
  startedAt: Date; // When session was created (monster spawned)
  actualBattleStartedAt?: Date; // When user clicked "Start Battle" button (for HP verification)
  completedAt?: Date;
  expiresAt: Date;
}

export interface BattleHistory {
  _id?: ObjectId;
  userId: string;
  sessionId: ObjectId;
  monsterTemplateName: string;
  selectedLootId?: string;
  createdAt: Date;
  completedAt?: Date;
}

// ========== Consumable System ==========
// Note: Consumable data is retrieved directly from loot-table.ts using getLootItemById()
// Effects are determined by item name/description in MonsterBattleSection.tsx

// ========== Monster Buff System ==========

export type MonsterBuffType =
  | 'shield'    // Has shield HP that must be broken first
  | 'fast';     // Escapes if not defeated in time

export interface MonsterBuff {
  type: MonsterBuffType;
  value: number; // For shield: shield HP amount, for fast: escape time in seconds
}

// ========== Boss Special Attack System ==========

export type SpecialAttackType =
  | 'fireball'     // Direct damage attack with visual effect
  | 'lightning'    // Direct damage attack
  | 'meteor'       // AoE damage
  | 'heal'         // Boss heals
  | 'summon';      // Summons creatures to fight alongside boss

export interface SummonDefinition {
  name: string;
  hpPercent: number;       // % of boss max HP (e.g., 15 = 15% of boss HP)
  attackDamage: number;    // Damage per second
  imageUrl: string;        // Emoji icon
}

export interface SpecialAttack {
  type: SpecialAttackType;
  damage?: number;         // Damage to player (if applicable)
  healing?: number;        // Healing to monster (if applicable)
  cooldown: number;        // Seconds between attacks
  minTier?: number;        // Minimum tier for this attack to be available (1-5)
  visualEffect?: string;   // Color for screen flash (e.g., 'orange', 'blue', 'purple')
  message?: string;        // Message to display to player
  summons?: {              // Summon configuration (for summon type)
    count: number;         // Number of creatures to summon (typically 1-2)
    creature: SummonDefinition;
  };
  // Interactive attack configuration (spawns clickable object that must be destroyed)
  interactive?: boolean;   // If true, spawns clickable object instead of instant damage
  objectHpPercent?: number; // % of boss max HP for the interactive object (e.g., 20 = 20% of boss HP)
  impactDelay?: number;    // Seconds before object impacts (if not destroyed)
  imageUrl?: string;       // Emoji icon for interactive object (e.g., '☄️', '🌪️', '🗿')
}

// Active summoned creature in battle
export interface SummonedCreature {
  id: string;              // Unique ID for this summon instance
  name: string;
  currentHP: number;
  maxHP: number;
  attackDamage: number;
  imageUrl: string;
  position: 'left' | 'right';
}

// Active interactive attack in battle (meteor, comet, etc.)
export interface InteractiveAttack {
  id: string;              // Unique ID for this attack instance
  name: string;            // Attack name (e.g., "Meteor", "Death Comet")
  currentHP: number;
  maxHP: number;
  damage: number;          // Damage dealt to player if not destroyed
  impactTime: number;      // Timestamp when attack will impact (Date.now() + impactDelay)
  visualEffect?: string;   // Color for visual effect
  imageUrl: string;        // Emoji icon (e.g., "☄️", "💥")
}

export interface BossPhase {
  phaseNumber: number;     // Phase to trigger (2, 3, 4, etc.) - Phase 1 is always initial
  hpThreshold: number;     // % HP boundary for this phase (e.g., 50 = divides at 50%)
                          // Creates stacked HP bars: 100%→50% (Phase 1), 50%→0% (Phase 2)
                          // Phase triggers when previous phase HP bar depletes (reaches 0)
                          // Excess damage is ignored at phase boundaries (like shields)
  invulnerabilityDuration: number; // MS of invulnerability during phase transition
  specialAttacks?: SpecialAttack[]; // Attacks executed during transition (heal, summon, etc.)
  message?: string;        // Toast message shown when phase starts
}

// ========== Debuff System ==========

export type DebuffType =
  | 'poison'    // Green - gradual damage over time
  | 'burn'      // Orange - higher damage over time
  | 'bleed'     // Red - medium damage over time
  | 'slow'      // Blue - reduces attack/click speed
  | 'stun'      // Yellow - prevents actions temporarily
  | 'freeze'    // Cyan - slows movement/attacks
  | 'defense_reduction'; // Gray - reduces player defense (skillshot failure penalty)

export type DamageType = 'flat' | 'percentage';

export interface DebuffEffect {
  type: DebuffType;
  damageType: DamageType;        // 'flat' or 'percentage'
  damageAmount: number;           // If percentage: 5 = 5% of max HP, if flat: raw damage
  tickInterval: number;           // MS between damage ticks (usually 1000)
  duration: number;               // Total duration in MS
  applyChance?: number;           // 0-100 chance to apply (optional, default 100)
}

export interface ActiveDebuff extends DebuffEffect {
  id: string;                     // Unique ID for tracking
  startTime: number;              // Timestamp when applied
  appliedBy?: string;             // Source (monster ID, spell ID, etc.)
  targetMaxHP: number;            // Max HP of target at time of application (for percentage calc)
}

// ========== Frontend Types (with string IDs) ==========

// Frontend Monster type (IDs as strings)
export interface MonsterFrontend {
  _id?: string;
  name: string;
  imageUrl: string;
  clicksRequired: number;
  attackDamage: number;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  biome: BiomeId;
  tier: Tier;
  moveInterval: number;           // Time in milliseconds between position changes (700-3000ms)
  createdAt: Date | string;
  isBoss?: boolean;               // True for boss monsters
  isCorrupted?: boolean;          // True for corrupted monsters (+50% HP, +25% damage)
  dotEffect?: DebuffEffect;       // Optional DoT effect on attack
  buffs?: MonsterBuff[];          // Monster buffs (Shield, Fast, etc.)
  specialAttacks?: SpecialAttack[]; // Boss special attacks
  bossPhases?: BossPhase[];       // Boss phase system
}

// Frontend Battle Session type (IDs as strings)
export interface BattleSessionFrontend {
  _id?: string;
  userId: string;
  biome: BiomeId;
  tier: Tier;
  monsterTemplateName?: string;
  monster?: MonsterFrontend;
  clickCount: number;
  isDefeated: boolean;
  lootOptions?: string[];
  selectedLootId?: string;
  usedItems?: Record<string, number>; // Track items used during battle
  startedAt: Date | string;
  actualBattleStartedAt?: Date | string; // When user clicked "Start Battle" button
  completedAt?: Date | string;
  expiresAt?: Date | string;
}

// Material Token document (for tracking blockchain material tokens with quantities)
export interface MaterialToken {
  _id?: ObjectId;
  userId: string;          // Reference to User.userId
  lootTableId: string;     // Reference to loot-table.ts (e.g., "iron_ore")
  itemName: string;        // Material name (e.g., "Iron Ore")
  tier: Tier;              // Material tier (1-5) - stored at root level for querying
  tokenId: string;         // Current blockchain outpoint (format: "txid.vout")
  transactionId?: string;  // DEPRECATED: Use tokenId instead (redundant, can be extracted from tokenId)
  quantity: number;        // Current quantity of this material
  metadata?: Record<string, any>; // Token metadata
  keyId?: string;          // Nonce used to derive the key locking this token (absent = legacy fixed key)
  counterparty?: string;   // Derivation counterparty (the server identity key that locked to user)
  mintOutpoint?: string;   // Server mint outpoint (txid.vout) - proves server minted token
  transferTransactionId?: string; // DEPRECATED: Use mintOutpoint/tokenId instead (redundant)
  consumed?: boolean;      // True if token was burned (quantity reached 0)
  consumedAt?: Date;       // When token was burned
  consumeTransactionId?: string; // Transaction ID of burn (no vout needed - item is consumed)
  previousTokenId?: string; // Previous token ID (for update history)
  lastTransactionId?: string; // DEPRECATED: Use tokenId instead (redundant)
  updateHistory?: Array<{  // History of all quantity updates
    operation: 'add' | 'subtract' | 'set';
    previousQuantity: number;
    newQuantity: number;
    transactionId: string;
    mergedFrom?: string[];   // Array of tokenIds that were merged (for 'add' operations using server merge)
    reason?: string;
    timestamp: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

// Marketplace Item document (for trading items between players)
export interface MarketplaceItem {
  _id?: ObjectId;
  sellerId: string;           // Reference to User.userId
  sellerUsername: string;     // Seller's username for display

  // Item reference (ONLY NFT items or material tokens)
  inventoryItemId?: string;   // Reference to UserInventory._id (for NFT equipment/consumables)
  materialTokenId?: string;   // Reference to MaterialToken._id (for material tokens)

  // Item data (duplicated for query performance)
  lootTableId: string;        // Reference to loot-table.ts
  itemName: string;           // Item name
  itemIcon: string;           // Emoji icon
  itemType: ItemType;         // Type of item
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  tier?: number;              // Item tier (1-5)

  // NFT-specific data
  tokenId?: string;           // Blockchain token ID (current location - txid.vout)
  transactionId?: string;     // Blockchain transaction ID (deprecated, use tokenId)

  // Material token specific
  quantity?: number;          // Quantity (for material tokens)

  // Pricing
  price: number;              // Price in satoshis (BSV)

  // OrdLock data (for on-chain marketplace)
  ordLockOutpoint?: string;   // Outpoint of orderLock UTXO (txid.vout)
  ordLockScript?: string;     // Full orderLock script hex (for validation)
  payAddress?: string;        // Address that receives payment (seller's address)
  assetId?: string;           // Asset ID used in OrdLock (txid_vout format)

  // Status
  status: 'active' | 'sold' | 'cancelled';
  listedAt: Date;
  soldAt?: Date;
  soldTo?: string;            // Buyer's userId
  cancelledAt?: Date;

  // Additional metadata (for equipment items)
  equipmentStats?: EquipmentStats;  // Base stats from loot table
  crafted?: boolean;          // True if item was crafted
  statRoll?: number;          // Stat roll multiplier (0.8 to 1.2) - frontend calculates: stats * statRoll
  isEmpowered?: boolean;      // True if dropped by corrupted monster (+20% stats)
  prefix?: any;               // Prefix inscription
  suffix?: any;               // Suffix inscription
}

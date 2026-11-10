/**
 * Crafting Recipe System
 *
 * Defines all crafting recipes in the game.
 * Players can combine materials to create weapons, armor, consumables, and artifacts.
 */

export interface MaterialRequirement {
  lootTableId: string; // Reference to loot-table.ts item
  quantity: number;
}

export interface CraftingOutput {
  lootTableId: string; // Reference to loot-table.ts item
  quantity: number;
  tier?: number; // Optional tier for tiered items (1-5)
}

export interface CraftingRecipe {
  recipeId: string;
  name: string;
  description: string;
  icon: string;
  category: 'weapon' | 'armor' | 'consumable' | 'artifact';
  requiredMaterials: MaterialRequirement[];
  output: CraftingOutput;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  unlocksAtLevel?: number; // Optional level requirement
}

// ============================
// WEAPON RECIPES
// ============================

const WEAPON_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_wooden_sword',
    name: 'Wooden Sword',
    description: 'A basic training sword',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'common_wood', quantity: 5 },
      { lootTableId: 'common_leather', quantity: 2 }
    ],
    output: { lootTableId: 'common_dagger', quantity: 1, tier: 1 },
    rarity: 'common'
  },
  {
    recipeId: 'craft_iron_sword',
    name: 'Iron Sword',
    description: 'A reliable steel blade',
    icon: '⚔️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'rare_steel', quantity: 4 },
      { lootTableId: 'common_wood', quantity: 3 },
      { lootTableId: 'common_leather', quantity: 2 }
    ],
    output: { lootTableId: 'silver_sword', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 3
  },
  {
    recipeId: 'craft_hunters_dagger',
    name: 'Hunter\'s Dagger',
    description: 'Sharp blade for quick strikes',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'wolf_fang', quantity: 3 },
      { lootTableId: 'rare_steel', quantity: 2 },
      { lootTableId: 'wolf_pelt', quantity: 1 }
    ],
    output: { lootTableId: 'hunter_dagger', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 2
  },
  {
    recipeId: 'craft_flame_sword',
    name: 'Flame Sword',
    description: 'Blade wreathed in eternal fire',
    icon: '🔥',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'fire_essence', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 10 },
      { lootTableId: 'ember_core', quantity: 3 },
      { lootTableId: 'dragon_scale', quantity: 2 }
    ],
    output: { lootTableId: 'flame_sword', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 8
  },
  {
    recipeId: 'craft_venom_blade',
    name: 'Venom Blade',
    description: 'Coated with deadly poison',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'viper_fang', quantity: 5 },
      { lootTableId: 'scorpion_tail', quantity: 3 },
      { lootTableId: 'rare_steel', quantity: 4 }
    ],
    output: { lootTableId: 'venom_dagger', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 4
  },
  // Phase 2.4 - Ocean Biome Weapons
  {
    recipeId: 'craft_frost_blade',
    name: 'Frost Blade',
    description: 'Freezes enemies on contact',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'shark_tooth', quantity: 4 },
      { lootTableId: 'frozen_scale', quantity: 6 },
      { lootTableId: 'rare_steel', quantity: 3 }
    ],
    output: { lootTableId: 'frost_blade', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_shock_dagger',
    name: 'Shock Dagger',
    description: 'Electrifies on contact',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'electric_organ', quantity: 3 },
      { lootTableId: 'eel_skin', quantity: 4 },
      { lootTableId: 'rare_steel', quantity: 2 }
    ],
    output: { lootTableId: 'shock_dagger', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_storm_blade',
    name: 'Storm Blade',
    description: 'Channels lightning strikes',
    icon: '⚔️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'serpent_scale', quantity: 8 },
      { lootTableId: 'lightning_core', quantity: 4 },
      { lootTableId: 'electric_organ', quantity: 6 },
      { lootTableId: 'rare_steel', quantity: 8 }
    ],
    output: { lootTableId: 'storm_blade', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 9
  },
  // Phase 2.4 - Volcano Biome Weapons
  {
    recipeId: 'craft_magma_hammer',
    name: 'Magma Hammer',
    description: 'Crushes with fiery force',
    icon: '🔨',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'golem_core', quantity: 2 },
      { lootTableId: 'obsidian_shard', quantity: 6 },
      { lootTableId: 'lava_stone', quantity: 8 }
    ],
    output: { lootTableId: 'magma_hammer', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_hellfire_dagger',
    name: 'Hellfire Dagger',
    description: 'Burns with cursed flames',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'demon_horn_shard', quantity: 4 },
      { lootTableId: 'imp_claw', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 3 }
    ],
    output: { lootTableId: 'hellfire_dagger', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_dragonfire_sword',
    name: 'Dragonfire Sword',
    description: 'Blazing with dragonfire',
    icon: '⚔️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'drake_scale', quantity: 10 },
      { lootTableId: 'drake_claw', quantity: 6 },
      { lootTableId: 'golem_core', quantity: 3 },
      { lootTableId: 'rare_steel', quantity: 8 }
    ],
    output: { lootTableId: 'dragonfire_sword', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 10
  },
  // Phase 2.4 - Castle Biome Weapons
  {
    recipeId: 'craft_blood_sword',
    name: 'Blood Sword',
    description: 'Thirsts for blood',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'vampire_fang', quantity: 6 },
      { lootTableId: 'blood_vial', quantity: 4 },
      { lootTableId: 'dark_steel', quantity: 5 }
    ],
    output: { lootTableId: 'blood_sword', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 6
  },
  {
    recipeId: 'craft_necrotic_sword',
    name: 'Necrotic Sword',
    description: 'Drains life on hit',
    icon: '⚔️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'dark_steel', quantity: 6 },
      { lootTableId: 'cursed_blade_fragment', quantity: 3 },
      { lootTableId: 'bone_shard', quantity: 10 }
    ],
    output: { lootTableId: 'necrotic_sword', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 6
  },
  {
    recipeId: 'craft_staff_of_souls',
    name: 'Staff of Souls',
    description: 'Commands the dead',
    icon: '🪄',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'necrotic_essence', quantity: 8 },
      { lootTableId: 'dark_crystal', quantity: 5 },
      { lootTableId: 'living_wood', quantity: 6 },
      { lootTableId: 'vampire_fang', quantity: 4 }
    ],
    output: { lootTableId: 'staff_of_souls', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 11
  }
];

// ============================
// ARMOR RECIPES
// ============================

const ARMOR_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_leather_vest',
    name: 'Leather Vest',
    description: 'Basic protective gear',
    icon: '🧥',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'wolf_pelt', quantity: 4 },
      { lootTableId: 'common_leather', quantity: 3 }
    ],
    output: { lootTableId: 'leather_vest', quantity: 1, tier: 1 },
    rarity: 'common'
  },
  {
    recipeId: 'craft_heavy_armor',
    name: 'Heavy Leather Armor',
    description: 'Reinforced protection',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'boar_hide', quantity: 6 },
      { lootTableId: 'rare_steel', quantity: 4 },
      { lootTableId: 'common_leather', quantity: 5 }
    ],
    output: { lootTableId: 'heavy_armor', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 3
  },
  {
    recipeId: 'craft_desert_wraps',
    name: 'Desert Wraps',
    description: 'Protects from heat and venom',
    icon: '🧣',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'snake_skin', quantity: 5 },
      { lootTableId: 'common_cloth', quantity: 8 }
    ],
    output: { lootTableId: 'desert_cloth', quantity: 1, tier: 1 },
    rarity: 'common',
    unlocksAtLevel: 2
  },
  {
    recipeId: 'craft_dragon_armor',
    name: 'Dragon Scale Armor',
    description: 'Nearly impenetrable defense',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'dragon_scale', quantity: 15 },
      { lootTableId: 'dragon_fang', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 10 },
      { lootTableId: 'troll_hide', quantity: 5 }
    ],
    output: { lootTableId: 'dragon_armor', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 10
  },
  {
    recipeId: 'craft_guardian_armor',
    name: 'Guardian\'s Bark Armor',
    description: 'Nature\'s protection',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'ancient_bark', quantity: 10 },
      { lootTableId: 'living_wood', quantity: 8 },
      { lootTableId: 'treant_heart', quantity: 1 }
    ],
    output: { lootTableId: 'guardian_armor', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 7
  },
  // Phase 2.4 - Ocean Biome Armor
  {
    recipeId: 'craft_shell_armor',
    name: 'Shell Armor',
    description: 'Reinforced with crab shell',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'crab_shell', quantity: 8 },
      { lootTableId: 'coral_fragment', quantity: 6 },
      { lootTableId: 'common_leather', quantity: 4 }
    ],
    output: { lootTableId: 'shell_armor', quantity: 1, tier: 1 },
    rarity: 'common',
    unlocksAtLevel: 4
  },
  {
    recipeId: 'craft_ice_armor',
    name: 'Frost Guard Armor',
    description: 'Chills attackers',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'frozen_scale', quantity: 10 },
      { lootTableId: 'shark_fin', quantity: 4 },
      { lootTableId: 'rare_steel', quantity: 6 }
    ],
    output: { lootTableId: 'ice_armor', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_tidal_armor',
    name: 'Tidal Scale Armor',
    description: 'Flows like water',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'serpent_scale', quantity: 12 },
      { lootTableId: 'frozen_scale', quantity: 8 },
      { lootTableId: 'rare_steel', quantity: 10 }
    ],
    output: { lootTableId: 'tidal_armor', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 9
  },
  // Phase 2.4 - Volcano Biome Armor
  {
    recipeId: 'craft_flame_cloak',
    name: 'Flame Cloak',
    description: 'Resists fire',
    icon: '🧥',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'molten_scale', quantity: 8 },
      { lootTableId: 'bat_wing', quantity: 6 },
      { lootTableId: 'ash_cloth', quantity: 10 }
    ],
    output: { lootTableId: 'flame_cloak', quantity: 1, tier: 1 },
    rarity: 'common',
    unlocksAtLevel: 4
  },
  {
    recipeId: 'craft_obsidian_armor',
    name: 'Obsidian Plate',
    description: 'Volcanic glass armor',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'golem_core', quantity: 3 },
      { lootTableId: 'obsidian_shard', quantity: 12 },
      { lootTableId: 'lava_stone', quantity: 10 }
    ],
    output: { lootTableId: 'obsidian_armor', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_drake_armor',
    name: 'Drake Scale Armor',
    description: 'Forged from drake scales',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'drake_scale', quantity: 15 },
      { lootTableId: 'golem_core', quantity: 4 },
      { lootTableId: 'rare_steel', quantity: 10 }
    ],
    output: { lootTableId: 'drake_armor', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 10
  },
  // Phase 2.4 - Castle Biome Armor
  {
    recipeId: 'craft_bone_armor',
    name: 'Bone Armor',
    description: 'Assembled from skeletons',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'bone_shard', quantity: 12 },
      { lootTableId: 'warrior_skull', quantity: 3 },
      { lootTableId: 'common_leather', quantity: 6 }
    ],
    output: { lootTableId: 'bone_armor', quantity: 1, tier: 1 },
    rarity: 'common',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_death_armor',
    name: 'Death Knight Armor',
    description: 'Forged for the undead',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'dark_steel', quantity: 10 },
      { lootTableId: 'cursed_blade_fragment', quantity: 4 },
      { lootTableId: 'bone_shard', quantity: 15 }
    ],
    output: { lootTableId: 'death_armor', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 6
  },
  {
    recipeId: 'craft_necro_robes',
    name: 'Necromancer\'s Robes',
    description: 'Radiates dark power',
    icon: '🧥',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'necrotic_essence', quantity: 10 },
      { lootTableId: 'cursed_cloth', quantity: 12 },
      { lootTableId: 'dark_crystal', quantity: 4 }
    ],
    output: { lootTableId: 'necro_robes', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 11
  }
];

// ============================
// CONSUMABLE RECIPES
// ============================

const CONSUMABLE_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_health_potion',
    name: 'Health Potion',
    description: 'Restores 20 HP',
    icon: '🧪',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'common_bone', quantity: 2 },
      { lootTableId: 'pixie_dust', quantity: 1 }
    ],
    output: { lootTableId: 'common_potion', quantity: 3 },
    rarity: 'common'
  },
  {
    recipeId: 'craft_forest_potion',
    name: 'Forest Potion',
    description: 'Restore 30 HP',
    icon: '🧪',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'pixie_dust', quantity: 3 },
      { lootTableId: 'fairy_wing', quantity: 2 },
      { lootTableId: 'common_bone', quantity: 4 }
    ],
    output: { lootTableId: 'health_potion_forest', quantity: 2 },
    rarity: 'rare',
    unlocksAtLevel: 3
  },
  {
    recipeId: 'craft_grand_elixir',
    name: 'Grand Elixir',
    description: 'Restores 50 HP',
    icon: '⚗️',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'troll_blood', quantity: 3 },
      { lootTableId: 'rare_gem', quantity: 2 },
      { lootTableId: 'pixie_dust', quantity: 5 }
    ],
    output: { lootTableId: 'rare_elixir', quantity: 2 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_antidote',
    name: 'Antidote Vial',
    description: 'Remove poison/burn effects',
    icon: '🧪',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'viper_fang', quantity: 2 },
      { lootTableId: 'pixie_dust', quantity: 1 }
    ],
    output: { lootTableId: 'antidote', quantity: 3 },
    rarity: 'common',
    unlocksAtLevel: 2
  },
  {
    recipeId: 'craft_mana_elixir',
    name: 'Mana Elixir',
    description: 'Restore 20 HP + remove 1 debuff',
    icon: '⚗️',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'ectoplasm', quantity: 3 },
      { lootTableId: 'spirit_crystal', quantity: 1 },
      { lootTableId: 'pixie_dust', quantity: 2 }
    ],
    output: { lootTableId: 'mana_elixir', quantity: 2 },
    rarity: 'rare',
    unlocksAtLevel: 4
  },
  {
    recipeId: 'craft_elixir_immortality',
    name: 'Elixir of Immortality',
    description: 'Restores 100 HP',
    icon: '🧬',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'dragon_heart', quantity: 1 },
      { lootTableId: 'vampire_blood', quantity: 5 },
      { lootTableId: 'rare_gem', quantity: 10 },
      { lootTableId: 'phoenix_feather', quantity: 1 }
    ],
    output: { lootTableId: 'elixir_immortality', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 15
  },
  // Phase 2.4 - Ocean Biome Consumables
  {
    recipeId: 'craft_sea_potion',
    name: 'Sea Potion',
    description: 'Restores 25 HP',
    icon: '🧪',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'jellyfish_tentacle', quantity: 3 },
      { lootTableId: 'bioluminescent_gel', quantity: 2 },
      { lootTableId: 'common_bone', quantity: 1 }
    ],
    output: { lootTableId: 'sea_potion', quantity: 3 },
    rarity: 'common',
    unlocksAtLevel: 4
  },
  // Phase 2.4 - Volcano Biome Consumables
  {
    recipeId: 'craft_lava_potion',
    name: 'Lava Potion',
    description: 'Fire resistance, restores 30 HP',
    icon: '🧪',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'lava_stone', quantity: 4 },
      { lootTableId: 'molten_scale', quantity: 3 },
      { lootTableId: 'pixie_dust', quantity: 2 }
    ],
    output: { lootTableId: 'lava_potion', quantity: 2 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  // Phase 2.4 - Castle Biome Consumables
  {
    recipeId: 'craft_spirit_vial',
    name: 'Spirit Vial',
    description: 'Contains spectral energy, restores 20 HP',
    icon: '🧪',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'ectoplasm_vial', quantity: 3 },
      { lootTableId: 'cursed_cloth', quantity: 2 }
    ],
    output: { lootTableId: 'spirit_vial', quantity: 3 },
    rarity: 'common',
    unlocksAtLevel: 5
  }
];

// ============================
// ARTIFACT RECIPES
// ============================

const ARTIFACT_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_lucky_coin',
    name: 'Lucky Coin',
    description: 'Increases coin drops',
    icon: '🪙',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'common_coin', quantity: 10 },
      { lootTableId: 'rare_gem', quantity: 1 }
    ],
    output: { lootTableId: 'rare_key', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 2
  },
  {
    recipeId: 'craft_speed_boots',
    name: 'Sandstorm Boots',
    description: 'Swift as the desert wind',
    icon: '👟',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'snake_skin', quantity: 4 },
      { lootTableId: 'common_leather', quantity: 6 },
      { lootTableId: 'pixie_dust', quantity: 2 }
    ],
    output: { lootTableId: 'speed_boots', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 3
  },
  {
    recipeId: 'craft_charging_boots',
    name: 'Charging Boots',
    description: 'Enables quick strikes',
    icon: '👢',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'boar_tusk', quantity: 4 },
      { lootTableId: 'boar_hide', quantity: 3 },
      { lootTableId: 'common_leather', quantity: 5 }
    ],
    output: { lootTableId: 'charging_boots', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 3
  },
  {
    recipeId: 'craft_enchanted_ring',
    name: 'Enchanted Ring',
    description: 'Hums with magical energy',
    icon: '💍',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'rare_gem', quantity: 3 },
      { lootTableId: 'ectoplasm', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 2 }
    ],
    output: { lootTableId: 'enchanted_ring', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 4
  },
  {
    recipeId: 'craft_sprite_ring',
    name: 'Sprite Ring',
    description: 'Enhances agility',
    icon: '💍',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'fairy_wing', quantity: 5 },
      { lootTableId: 'pixie_dust', quantity: 8 },
      { lootTableId: 'rare_gem', quantity: 2 }
    ],
    output: { lootTableId: 'sprite_ring', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 3
  },
  {
    recipeId: 'craft_blood_chalice',
    name: 'Blood Chalice',
    description: 'An ancient vampiric relic',
    icon: '🏆',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'vampire_blood', quantity: 10 },
      { lootTableId: 'dragon_heart', quantity: 1 },
      { lootTableId: 'rare_gem', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 8 }
    ],
    output: { lootTableId: 'blood_chalice', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 9
  },
  // Phase 2.4 - Ocean Biome Artifacts
  {
    recipeId: 'craft_storm_amulet',
    name: 'Storm Amulet',
    description: 'Crackles with energy',
    icon: '📿',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'electric_organ', quantity: 6 },
      { lootTableId: 'rare_gem', quantity: 3 },
      { lootTableId: 'rare_steel', quantity: 2 }
    ],
    output: { lootTableId: 'storm_amulet', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_ocean_crown',
    name: 'Crown of the Deep',
    description: 'Commands the seas',
    icon: '👑',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'serpent_scale', quantity: 10 },
      { lootTableId: 'lightning_core', quantity: 3 },
      { lootTableId: 'rare_gem', quantity: 5 },
      { lootTableId: 'coral_fragment', quantity: 12 }
    ],
    output: { lootTableId: 'ocean_crown', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 9
  },
  // Phase 2.4 - Volcano Biome Artifacts
  {
    recipeId: 'craft_inferno_ring',
    name: 'Ring of Inferno',
    description: 'Enhances fire attacks',
    icon: '💍',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'demon_horn_shard', quantity: 5 },
      { lootTableId: 'rare_gem', quantity: 2 },
      { lootTableId: 'fire_essence', quantity: 4 }
    ],
    output: { lootTableId: 'inferno_ring', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 5
  },
  {
    recipeId: 'craft_flame_pendant',
    name: 'Flame Pendant',
    description: 'Burns eternally',
    icon: '📿',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'drake_claw', quantity: 6 },
      { lootTableId: 'rare_gem', quantity: 4 },
      { lootTableId: 'golem_core', quantity: 2 }
    ],
    output: { lootTableId: 'flame_pendant', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 10
  },
  // Phase 2.4 - Castle Biome Artifacts
  {
    recipeId: 'craft_shadow_ring',
    name: 'Shadow Ring',
    description: 'Hides in darkness',
    icon: '💍',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'dark_steel', quantity: 4 },
      { lootTableId: 'rare_gem', quantity: 2 },
      { lootTableId: 'cursed_cloth', quantity: 6 }
    ],
    output: { lootTableId: 'shadow_ring', quantity: 1, tier: 1 },
    rarity: 'rare',
    unlocksAtLevel: 6
  },
  {
    recipeId: 'craft_phylactery',
    name: 'Phylactery',
    description: 'Stores a soul',
    icon: '⚱️',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'necrotic_essence', quantity: 8 },
      { lootTableId: 'dark_crystal', quantity: 6 },
      { lootTableId: 'vampire_fang', quantity: 10 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'phylactery', quantity: 1, tier: 2 },
    rarity: 'epic',
    unlocksAtLevel: 11
  }
];

// ============================
// CRAFT-ONLY RECIPES
// These recipes create items that CANNOT be obtained from monster drops
// ============================

const CRAFT_ONLY_WEAPON_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_masterwork_blade',
    name: 'Masterwork Blade',
    description: 'Perfectly balanced steel sword',
    icon: '⚔️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'rare_steel', quantity: 12 },
      { lootTableId: 'rare_gem', quantity: 3 },
      { lootTableId: 'wolf_fang', quantity: 6 }
    ],
    output: { lootTableId: 'masterwork_blade', quantity: 1 },
    rarity: 'rare',
    unlocksAtLevel: 6
  },
  {
    recipeId: 'craft_alchemists_staff',
    name: 'Alchemist\'s Staff',
    description: 'Infused with magical properties',
    icon: '🪄',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'living_wood', quantity: 10 },
      { lootTableId: 'spirit_crystal', quantity: 5 },
      { lootTableId: 'ectoplasm', quantity: 8 },
      { lootTableId: 'rare_gem', quantity: 4 }
    ],
    output: { lootTableId: 'alchemists_staff', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 10
  },
  {
    recipeId: 'craft_vorpal_blade',
    name: 'Vorpal Blade',
    description: 'Legendary blade that strikes true',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'dragon_fang', quantity: 4 },
      { lootTableId: 'demon_horn', quantity: 3 },
      { lootTableId: 'rare_steel', quantity: 5 },
      { lootTableId: 'soul_stone', quantity: 1 }
    ],
    output: { lootTableId: 'vorpal_blade', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 18
  },
  // Phase 2.4 - Ocean Craft-Only Weapons
  {
    recipeId: 'craft_tidal_reaver',
    name: 'Tidal Reaver',
    description: 'Legendary trident of the sea',
    icon: '🔱',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'leviathan_scale', quantity: 5 },
      { lootTableId: 'ocean_heart', quantity: 2 },
      { lootTableId: 'serpent_scale', quantity: 6 },
      { lootTableId: 'lightning_core', quantity: 4 },
      { lootTableId: 'rare_steel', quantity: 5 }
    ],
    output: { lootTableId: 'tidal_reaver', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 16
  },
  // Phase 2.4 - Volcano Craft-Only Weapons
  {
    recipeId: 'craft_infernal_claymore',
    name: 'Infernal Claymore',
    description: 'Forged in volcanic fury',
    icon: '⚔️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'ancient_dragon_scale', quantity: 6 },
      { lootTableId: 'dragon_soul', quantity: 2 },
      { lootTableId: 'drake_scale', quantity: 5 },
      { lootTableId: 'golem_core', quantity: 4 },
      { lootTableId: 'rare_steel', quantity: 5 }
    ],
    output: { lootTableId: 'infernal_claymore', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 17
  },
  // Phase 2.4 - Castle Craft-Only Weapons
  {
    recipeId: 'craft_reaper_scythe',
    name: 'Reaper\'s Scythe',
    description: 'Harvests souls of the living',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'lich_crown', quantity: 1 },
      { lootTableId: 'void_essence', quantity: 4 },
      { lootTableId: 'necrotic_essence', quantity: 5 },
      { lootTableId: 'dark_crystal', quantity: 4 },
      { lootTableId: 'dark_steel', quantity: 6 }
    ],
    output: { lootTableId: 'reaper_scythe', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 16
  },
  // Phase 2.5 - Advanced Legendary Items with special effects
  {
    recipeId: 'craft_excalibur',
    name: 'Excalibur',
    description: 'The legendary sword of kings - strikes with divine fury',
    icon: '⚔️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'soul_stone', quantity: 2 },
      { lootTableId: 'phoenix_feather', quantity: 3 },
      { lootTableId: 'dragon_heart', quantity: 2 },
      { lootTableId: 'rare_steel', quantity: 6 },
      { lootTableId: 'rare_gem', quantity: 5 },
      { lootTableId: 'millennium_root', quantity: 3 }
    ],
    output: { lootTableId: 'excalibur', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  },
  {
    recipeId: 'craft_scarlet_dagger',
    name: 'Scarlet Dagger',
    description: 'Crimson blade that thirsts for blood - heals with every strike',
    icon: '🗡️',
    category: 'weapon',
    requiredMaterials: [
      { lootTableId: 'vampire_blood', quantity: 6 },
      { lootTableId: 'blood_chalice', quantity: 1 },
      { lootTableId: 'demon_horn', quantity: 4 },
      { lootTableId: 'rare_steel', quantity: 5 },
      { lootTableId: 'rare_gem', quantity: 5 },
      { lootTableId: 'crimson_crown', quantity: 1 }
    ],
    output: { lootTableId: 'scarlet_dagger', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  }
];

const CRAFT_ONLY_ARMOR_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_reinforced_steel_plate',
    name: 'Reinforced Steel Plate',
    description: 'Heavy armor with exceptional protection',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'rare_steel', quantity: 15 },
      { lootTableId: 'troll_hide', quantity: 8 },
      { lootTableId: 'boar_hide', quantity: 10 }
    ],
    output: { lootTableId: 'reinforced_steel_plate', quantity: 1 },
    rarity: 'rare',
    unlocksAtLevel: 6
  },
  {
    recipeId: 'craft_enchanted_silk_robes',
    name: 'Enchanted Silk Robes',
    description: 'Light armor imbued with protective magic',
    icon: '🧥',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'fairy_wing', quantity: 10 },
      { lootTableId: 'pixie_dust', quantity: 12 },
      { lootTableId: 'spirit_crystal', quantity: 5 },
      { lootTableId: 'common_cloth', quantity: 10 }
    ],
    output: { lootTableId: 'enchanted_silk_robes', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 11
  },
  {
    recipeId: 'craft_titans_armor',
    name: 'Titan\'s Armor',
    description: 'Armor of the ancient giants',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'dragon_scale', quantity: 6 },
      { lootTableId: 'rare_steel', quantity: 5 },
      { lootTableId: 'treant_heart', quantity: 3 },
      { lootTableId: 'demon_horn', quantity: 3 }
    ],
    output: { lootTableId: 'titans_armor', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  },
  // Phase 2.4 - Ocean Craft-Only Armor
  {
    recipeId: 'craft_abyssal_plate',
    name: 'Abyssal Plate',
    description: 'Forged in the deepest trenches',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'leviathan_scale', quantity: 5 },
      { lootTableId: 'ocean_heart', quantity: 1 },
      { lootTableId: 'serpent_scale', quantity: 6 },
      { lootTableId: 'frozen_scale', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 5 }
    ],
    output: { lootTableId: 'abyssal_plate', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 18
  },
  // Phase 2.4 - Volcano Craft-Only Armor
  {
    recipeId: 'craft_dragonlord_armor',
    name: 'Dragonlord Armor',
    description: 'Ultimate volcanic protection',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'ancient_dragon_scale', quantity: 6 },
      { lootTableId: 'dragon_soul', quantity: 1 },
      { lootTableId: 'drake_scale', quantity: 5 },
      { lootTableId: 'golem_core', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 5 }
    ],
    output: { lootTableId: 'dragonlord_armor', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 19
  },
  // Phase 2.4 - Castle Craft-Only Armor
  {
    recipeId: 'craft_dreadlord_plate',
    name: 'Dreadlord Plate',
    description: 'Eternal undead protection',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'lich_crown', quantity: 1 },
      { lootTableId: 'void_essence', quantity: 4 },
      { lootTableId: 'necrotic_essence', quantity: 5 },
      { lootTableId: 'dark_steel', quantity: 6 },
      { lootTableId: 'bone_shard', quantity: 6 }
    ],
    output: { lootTableId: 'dreadlord_plate', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 18
  },
  // NEW: Archetype-Specific Epic Armor
  {
    recipeId: 'craft_assassins_leathers',
    name: 'Assassin\'s Leathers',
    description: 'Light armor for precision strikes',
    icon: '🥋',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'wolf_pelt', quantity: 8 },
      { lootTableId: 'fairy_wing', quantity: 12 },
      { lootTableId: 'rare_gem', quantity: 6 },
      { lootTableId: 'pixie_dust', quantity: 10 }
    ],
    output: { lootTableId: 'assassins_leathers', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 12
  },
  {
    recipeId: 'craft_battle_robes',
    name: 'Battle Robes',
    description: 'Balanced protection and utility',
    icon: '🧥',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'spirit_crystal', quantity: 8 },
      { lootTableId: 'boar_hide', quantity: 10 },
      { lootTableId: 'rare_steel', quantity: 6 },
      { lootTableId: 'common_cloth', quantity: 12 }
    ],
    output: { lootTableId: 'battle_robes', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 11
  },
  {
    recipeId: 'craft_bulwark_plate',
    name: 'Bulwark Plate',
    description: 'Impenetrable heavy armor',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'rare_steel', quantity: 12 },
      { lootTableId: 'troll_hide', quantity: 8 },
      { lootTableId: 'dragon_scale', quantity: 6 },
      { lootTableId: 'demon_horn', quantity: 4 }
    ],
    output: { lootTableId: 'bulwark_plate', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 13
  },
  {
    recipeId: 'craft_berserkers_vest',
    name: 'Berserker\'s Vest',
    description: 'Pure offensive power',
    icon: '🎽',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'wolf_fang', quantity: 10 },
      { lootTableId: 'viper_fang', quantity: 8 },
      { lootTableId: 'rare_steel', quantity: 6 },
      { lootTableId: 'blood_vial', quantity: 4 }
    ],
    output: { lootTableId: 'berserkers_vest', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 14
  },
  // NEW: Archetype-Specific Legendary Armor
  {
    recipeId: 'craft_shadowdancer_silk',
    name: 'Shadowdancer Silk',
    description: 'Ethereal armor of legendary assassins',
    icon: '🥷',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'fairy_wing', quantity: 6 },
      { lootTableId: 'pixie_dust', quantity: 6 },
      { lootTableId: 'void_essence', quantity: 4 },
      { lootTableId: 'soul_stone', quantity: 2 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'shadowdancer_silk', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 19
  },
  {
    recipeId: 'craft_fortress_plate',
    name: 'Fortress Plate',
    description: 'Living citadel of impenetrable defense',
    icon: '🛡️',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'dragon_scale', quantity: 6 },
      { lootTableId: 'treant_heart', quantity: 3 },
      { lootTableId: 'golem_core', quantity: 4 },
      { lootTableId: 'rare_steel', quantity: 6 },
      { lootTableId: 'demon_horn', quantity: 3 }
    ],
    output: { lootTableId: 'fortress_plate', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  },
  {
    recipeId: 'craft_warlords_regalia',
    name: 'Warlord\'s Regalia',
    description: 'Armor of legendary commanders',
    icon: '👑',
    category: 'armor',
    requiredMaterials: [
      { lootTableId: 'dragon_scale', quantity: 5 },
      { lootTableId: 'phoenix_feather', quantity: 3 },
      { lootTableId: 'rare_steel', quantity: 5 },
      { lootTableId: 'rare_gem', quantity: 4 },
      { lootTableId: 'soul_stone', quantity: 1 }
    ],
    output: { lootTableId: 'warlords_regalia', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 18
  }
];

const CRAFT_ONLY_CONSUMABLE_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_concentrated_elixir',
    name: 'Concentrated Elixir',
    description: 'Restores 75 HP',
    icon: '⚗️',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'troll_blood', quantity: 5 },
      { lootTableId: 'vampire_blood', quantity: 3 },
      { lootTableId: 'rare_gem', quantity: 4 },
      { lootTableId: 'pixie_dust', quantity: 10 }
    ],
    output: { lootTableId: 'concentrated_elixir', quantity: 2 },
    rarity: 'rare',
    unlocksAtLevel: 7
  },
  {
    recipeId: 'craft_transmutation_potion',
    name: 'Transmutation Potion',
    description: 'Restores 50 HP + grants 30s damage buff',
    icon: '🧪',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'dragon_heart', quantity: 1 },
      { lootTableId: 'fire_essence', quantity: 8 },
      { lootTableId: 'spirit_crystal', quantity: 5 },
      { lootTableId: 'pixie_dust', quantity: 10 }
    ],
    output: { lootTableId: 'transmutation_potion', quantity: 2 },
    rarity: 'epic',
    unlocksAtLevel: 12
  },
  {
    recipeId: 'craft_phoenix_tear',
    name: 'Phoenix Tear',
    description: 'Fully restores HP',
    icon: '💧',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'phoenix_feather', quantity: 3 },
      { lootTableId: 'dragon_heart', quantity: 2 },
      { lootTableId: 'rare_gem', quantity: 10 },
      { lootTableId: 'vampire_blood', quantity: 10 }
    ],
    output: { lootTableId: 'phoenix_tear', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  },
  {
    recipeId: 'craft_refine_stone',
    name: 'Refine Stone',
    description: 'Rerolls stat quality on crafted equipment',
    icon: '💎',
    category: 'consumable',
    requiredMaterials: [
      { lootTableId: 'soul_stone', quantity: 1 },
      { lootTableId: 'dragon_heart', quantity: 1 },
      { lootTableId: 'ancient_dragon_scale', quantity: 3 },
      { lootTableId: 'void_essence', quantity: 3 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'refine_stone', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  }
];

const CRAFT_ONLY_ARTIFACT_RECIPES: CraftingRecipe[] = [
  {
    recipeId: 'craft_master_craftsman_ring',
    name: 'Master Craftsman\'s Ring',
    description: 'Enhances all combat abilities',
    icon: '💍',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'rare_gem', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 8 },
      { lootTableId: 'pixie_dust', quantity: 10 }
    ],
    output: { lootTableId: 'master_craftsman_ring', quantity: 1 },
    rarity: 'rare',
    unlocksAtLevel: 6
  },
  {
    recipeId: 'craft_arcane_amplifier',
    name: 'Arcane Amplifier',
    description: 'Boosts magical power',
    icon: '🔮',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'soul_stone', quantity: 1 },
      { lootTableId: 'spirit_crystal', quantity: 8 },
      { lootTableId: 'djinn_essence', quantity: 5 },
      { lootTableId: 'rare_gem', quantity: 10 }
    ],
    output: { lootTableId: 'arcane_amplifier', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 13
  },
  {
    recipeId: 'craft_infinity_amulet',
    name: 'Infinity Amulet',
    description: 'Contains limitless power',
    icon: '🔱',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'soul_stone', quantity: 3 },
      { lootTableId: 'chaos_orb', quantity: 1 },
      { lootTableId: 'phoenix_feather', quantity: 3 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'infinity_amulet', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 25
  },
  // Phase 2.4 - Ocean Craft-Only Artifacts
  {
    recipeId: 'craft_maelstrom_pendant',
    name: 'Maelstrom Pendant',
    description: 'Harnesses the fury of the ocean',
    icon: '🌊',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'ocean_heart', quantity: 3 },
      { lootTableId: 'tidal_orb', quantity: 1 },
      { lootTableId: 'lightning_core', quantity: 4 },
      { lootTableId: 'serpent_scale', quantity: 6 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'maelstrom_pendant', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 18
  },
  // Phase 2.4 - Volcano Craft-Only Artifacts
  {
    recipeId: 'craft_volcanic_heart',
    name: 'Volcanic Heart',
    description: 'Pulses with molten power',
    icon: '🔥',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'dragon_soul', quantity: 3 },
      { lootTableId: 'dragon_amulet', quantity: 1 },
      { lootTableId: 'golem_core', quantity: 5 },
      { lootTableId: 'drake_claw', quantity: 6 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'volcanic_heart', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 19
  },
  // Phase 2.4 - Castle Craft-Only Artifacts
  {
    recipeId: 'craft_crown_of_eternity',
    name: 'Crown of Eternity',
    description: 'Rules over life and death',
    icon: '👑',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'lich_crown', quantity: 2 },
      { lootTableId: 'death_orb', quantity: 1 },
      { lootTableId: 'void_essence', quantity: 5 },
      { lootTableId: 'dark_crystal', quantity: 5 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'crown_of_eternity', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  },
  // NEW: Archetype-Specific Epic Artifacts
  {
    recipeId: 'craft_assassins_mark',
    name: 'Assassin\'s Mark',
    description: 'Cursed relic of deadly precision',
    icon: '💀',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'demon_eye', quantity: 3 },
      { lootTableId: 'vampire_blood', quantity: 8 },
      { lootTableId: 'dark_crystal', quantity: 6 },
      { lootTableId: 'rare_gem', quantity: 8 }
    ],
    output: { lootTableId: 'assassins_mark', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 13
  },
  {
    recipeId: 'craft_executioners_eye',
    name: 'Executioner\'s Eye',
    description: 'See enemy weaknesses',
    icon: '👁️',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'demon_eye', quantity: 2 },
      { lootTableId: 'dragon_fang', quantity: 6 },
      { lootTableId: 'viper_fang', quantity: 8 },
      { lootTableId: 'rare_gem', quantity: 6 }
    ],
    output: { lootTableId: 'executioners_eye', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 14
  },
  {
    recipeId: 'craft_guardians_talisman',
    name: 'Guardian\'s Talisman',
    description: 'Sacred relic of protectors',
    icon: '🛡️',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'treant_heart', quantity: 2 },
      { lootTableId: 'dragon_scale', quantity: 8 },
      { lootTableId: 'spirit_crystal', quantity: 6 },
      { lootTableId: 'rare_gem', quantity: 8 }
    ],
    output: { lootTableId: 'guardians_talisman', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 12
  },
  {
    recipeId: 'craft_ironheart_stone',
    name: 'Ironheart Stone',
    description: 'Endurance of stone',
    icon: '💎',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'golem_core', quantity: 6 },
      { lootTableId: 'treant_heart', quantity: 2 },
      { lootTableId: 'dragon_scale', quantity: 6 },
      { lootTableId: 'rare_steel', quantity: 8 }
    ],
    output: { lootTableId: 'ironheart_stone', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 13
  },
  {
    recipeId: 'craft_adventurers_compass',
    name: 'Adventurer\'s Compass',
    description: 'Guides to fortune and survival',
    icon: '🧭',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'rare_gem', quantity: 8 },
      { lootTableId: 'rare_steel', quantity: 6 },
      { lootTableId: 'spirit_crystal', quantity: 6 },
      { lootTableId: 'pixie_dust', quantity: 8 }
    ],
    output: { lootTableId: 'adventurers_compass', quantity: 1 },
    rarity: 'epic',
    unlocksAtLevel: 11
  },
  // NEW: Archetype-Specific Legendary Artifacts
  {
    recipeId: 'craft_heart_of_reaper',
    name: 'Heart of the Reaper',
    description: 'Ultimate offensive artifact',
    icon: '💀',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'void_essence', quantity: 5 },
      { lootTableId: 'demon_horn', quantity: 4 },
      { lootTableId: 'soul_stone', quantity: 3 },
      { lootTableId: 'lich_crown', quantity: 1 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'heart_of_reaper', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 21
  },
  {
    recipeId: 'craft_perfect_prism',
    name: 'Perfect Prism',
    description: 'Focuses power into critical strikes',
    icon: '🔷',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'rare_gem', quantity: 6 },
      { lootTableId: 'spirit_crystal', quantity: 5 },
      { lootTableId: 'phoenix_feather', quantity: 3 },
      { lootTableId: 'soul_stone', quantity: 2 }
    ],
    output: { lootTableId: 'perfect_prism', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  },
  {
    recipeId: 'craft_aegis_of_titans',
    name: 'Aegis of Titans',
    description: 'Legendary shield of ancient giants',
    icon: '🛡️',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'dragon_scale', quantity: 6 },
      { lootTableId: 'treant_heart', quantity: 3 },
      { lootTableId: 'golem_core', quantity: 5 },
      { lootTableId: 'soul_stone', quantity: 2 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'aegis_of_titans', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 22
  },
  {
    recipeId: 'craft_bastion_core',
    name: 'Bastion Core',
    description: 'Mechanical heart of ancient guardian',
    icon: '⚙️',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'golem_core', quantity: 5 },
      { lootTableId: 'dragon_scale', quantity: 5 },
      { lootTableId: 'rare_steel', quantity: 6 },
      { lootTableId: 'demon_horn', quantity: 3 },
      { lootTableId: 'rare_gem', quantity: 5 }
    ],
    output: { lootTableId: 'bastion_core', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 20
  },
  {
    recipeId: 'craft_equilibrium_orb',
    name: 'Equilibrium Orb',
    description: 'Perfect balance of offense and defense',
    icon: '☯️',
    category: 'artifact',
    requiredMaterials: [
      { lootTableId: 'soul_stone', quantity: 3 },
      { lootTableId: 'phoenix_feather', quantity: 3 },
      { lootTableId: 'dragon_heart', quantity: 2 },
      { lootTableId: 'rare_steel', quantity: 10 },
      { lootTableId: 'rare_gem', quantity: 10 }
    ],
    output: { lootTableId: 'equilibrium_orb', quantity: 1 },
    rarity: 'legendary',
    unlocksAtLevel: 19
  }
];

// ============================
// ALL RECIPES
// ============================

const ALL_RECIPES: CraftingRecipe[] = [
  ...WEAPON_RECIPES,
  ...ARMOR_RECIPES,
  ...CONSUMABLE_RECIPES,
  ...ARTIFACT_RECIPES,
  ...CRAFT_ONLY_WEAPON_RECIPES,
  ...CRAFT_ONLY_ARMOR_RECIPES,
  ...CRAFT_ONLY_CONSUMABLE_RECIPES,
  ...CRAFT_ONLY_ARTIFACT_RECIPES
];

// Create a map for quick lookup by recipeId
const RECIPE_MAP = new Map<string, CraftingRecipe>();
ALL_RECIPES.forEach(recipe => {
  RECIPE_MAP.set(recipe.recipeId, recipe);
});

// ============================
// HELPER FUNCTIONS
// ============================

/**
 * Get all crafting recipes
 */
export function getAllRecipes(): CraftingRecipe[] {
  return ALL_RECIPES;
}

/**
 * Get recipes by category
 */
export function getRecipesByCategory(category: 'weapon' | 'armor' | 'consumable' | 'artifact'): CraftingRecipe[] {
  return ALL_RECIPES.filter(recipe => recipe.category === category);
}

/**
 * Get recipe by ID
 */
export function getRecipeById(recipeId: string): CraftingRecipe | undefined {
  return RECIPE_MAP.get(recipeId);
}

/**
 * Get recipes unlocked at or below a specific level
 */
export function getUnlockedRecipes(playerLevel: number): CraftingRecipe[] {
  return ALL_RECIPES.filter(recipe => {
    return !recipe.unlocksAtLevel || recipe.unlocksAtLevel <= playerLevel;
  });
}

/**
 * Get recipes by rarity
 */
export function getRecipesByRarity(rarity: 'common' | 'rare' | 'epic' | 'legendary'): CraftingRecipe[] {
  return ALL_RECIPES.filter(recipe => recipe.rarity === rarity);
}

/**
 * Check if player has enough materials for a recipe
 * Returns { canCraft: boolean, missing: MaterialRequirement[] }
 */
export function checkMaterialsForRecipe(
  recipe: CraftingRecipe,
  playerMaterials: Map<string, number>
): { canCraft: boolean; missing: MaterialRequirement[] } {
  const missing: MaterialRequirement[] = [];

  for (const requirement of recipe.requiredMaterials) {
    const playerQuantity = playerMaterials.get(requirement.lootTableId) || 0;
    if (playerQuantity < requirement.quantity) {
      missing.push({
        lootTableId: requirement.lootTableId,
        quantity: requirement.quantity - playerQuantity
      });
    }
  }

  return {
    canCraft: missing.length === 0,
    missing
  };
}

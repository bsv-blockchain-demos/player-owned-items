import { describe, it, expect } from 'vitest';
import { craftBatch, craftTransfers, type CraftingInputItem } from './useCraftItemNFT';

const input = (over: Partial<CraftingInputItem>): CraftingInputItem => ({
  inventoryItemId: 'INV',
  name: 'x',
  rarity: 'common',
  type: 'material',
  itemType: 'material',
  quantityNeeded: 1,
  ...over,
});

describe('craft batch layout', () => {
  const crystal = input({ inventoryItemId: 'CRYSTAL_INV', lootTableId: 'spirit_crystal', tokenId: 'C.0', itemType: 'artifact', type: 'artifact' });
  const ecto = input({ inventoryItemId: 'ECTO_INV', nftLootId: 'ECTO_TOKEN', lootTableId: 'ectoplasm', tokenId: 'E.0' });
  const pixie = input({ inventoryItemId: 'PIXIE_INV', nftLootId: 'PIXIE_TOKEN', lootTableId: 'pixie_dust', tokenId: 'P.0' });
  const unminted = input({ inventoryItemId: 'NOPE', lootTableId: 'ectoplasm' });

  it('puts materials first, then items, and drops inputs without a token', () => {
    expect(craftBatch([crystal, ecto, unminted, pixie])).toEqual([ecto, pixie, crystal]);
  });

  it('names each transfer by its batch output index', () => {
    const batch = craftBatch([crystal, ecto, pixie]);
    expect(craftTransfers(batch, 'TX')).toEqual({
      transferredMaterials: [
        { lootTableId: 'ectoplasm', tokenId: 'TX.0', materialTokenId: 'ECTO_TOKEN' },
        { lootTableId: 'pixie_dust', tokenId: 'TX.1', materialTokenId: 'PIXIE_TOKEN' },
      ],
      transferredItems: [{ lootTableId: 'spirit_crystal', tokenId: 'TX.2', inventoryItemId: 'CRYSTAL_INV' }],
    });
  });
});

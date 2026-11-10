import { inscriptionConflict, inscriptionGoldCost } from '@shared/inscriptions';
import type { InscriptionData } from '@shared/types';

const scroll = (inscriptionType: InscriptionData['inscriptionType'], slot: 'prefix' | 'suffix'): InscriptionData => ({
  inscriptionType, slot, statValue: 1, name: 'x', description: 'x',
});

describe('inscriptionConflict', () => {
  it.each(['autoclick', 'lifesteal'] as const)('flags a %s scroll when the opposite slot has the same type', (type) => {
    expect(inscriptionConflict({ prefix: { type, value: 1, name: 'p' } }, scroll(type, 'suffix'))).toBe(type);
    expect(inscriptionConflict({ suffix: { type, value: 1, name: 's' } }, scroll(type, 'prefix'))).toBe(type);
  });

  it('allows replacing the same slot', () => {
    expect(inscriptionConflict({ prefix: { type: 'autoclick', value: 1, name: 'p' } }, scroll('autoclick', 'prefix'))).toBeNull();
  });

  it('allows non-exclusive types on both slots', () => {
    expect(inscriptionConflict({ prefix: { type: 'damage', value: 1, name: 'p' } }, scroll('damage', 'suffix'))).toBeNull();
  });

  it('allows an empty item', () => {
    expect(inscriptionConflict({}, scroll('lifesteal', 'suffix'))).toBeNull();
  });
});

describe('inscriptionGoldCost', () => {
  it.each([['common', 250], ['rare', 1000], ['epic', 2500], ['legendary', 5000]])('%s scroll costs %i gold', (rarity, cost) => {
    expect(inscriptionGoldCost(rarity)).toBe(cost);
  });
});

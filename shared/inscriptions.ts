import type { Inscription, InscriptionData, InscriptionType } from '@shared/types';

/** A prefix and suffix of the same one of these types may not stack on one item. */
export const EXCLUSIVE_INSCRIPTION_TYPES: readonly InscriptionType[] = ['autoclick', 'lifesteal'];

/** The exclusive type a scroll would duplicate across the item's prefix and suffix, or null. */
export function inscriptionConflict(
  item: { prefix?: Inscription | null; suffix?: Inscription | null },
  scroll: InscriptionData,
): InscriptionType | null {
  if (!EXCLUSIVE_INSCRIPTION_TYPES.includes(scroll.inscriptionType)) return null;
  const opposite = scroll.slot === 'prefix' ? item.suffix : item.prefix;
  return opposite?.type === scroll.inscriptionType ? scroll.inscriptionType : null;
}

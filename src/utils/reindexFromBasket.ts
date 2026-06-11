// src/utils/reindexFromBasket.ts
import type { WalletInterface } from '@bsv/sdk';
import { TOKEN_BASKET } from './internalizeToBasket';

export interface IndexedOutput {
  outpoint: string;
  satoshis: number;
  keyId: string;
  counterparty: string;
  tags?: string[];
}

/** Recovery only (not the spend path): rebuild the DB nonce index from the wallet basket. */
export async function reindexFromBasket(
  wallet: WalletInterface,
  tags?: string[],
): Promise<IndexedOutput[]> {
  const res = await wallet.listOutputs({
    basket: TOKEN_BASKET,
    tags,
    includeCustomInstructions: true,
  });
  return res.outputs.map((o: any) => {
    const ci = JSON.parse(o.customInstructions || '{}');
    return {
      outpoint: o.outpoint,
      satoshis: o.satoshis,
      keyId: ci.keyId,
      counterparty: ci.counterparty,
      tags: o.tags,
    };
  });
}

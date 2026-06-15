// src/utils/internalizeToBasket.ts
import type { WalletInterface } from '@bsv/sdk';
import { TOKEN_PROTOCOL } from './tokenDerivation';

export const TOKEN_BASKET = 'monsterbattle.tokens';

export interface ReceivedOutput {
  outputIndex: number;
  keyId: string;        // nonce used to lock this output
  counterparty: string; // who locked it (identity key) — needed to unlock
  tags?: string[];
}

/** Record an existing tx's outputs into the owner's basket, storing each nonce in customInstructions. Does not broadcast. */
export async function internalizeToBasket(
  wallet: WalletInterface,
  atomicBeef: number[],
  outputs: ReceivedOutput[],
  description: string,
): Promise<void> {
  await wallet.internalizeAction({
    tx: atomicBeef,
    description,
    outputs: outputs.map((o) => ({
      outputIndex: o.outputIndex,
      protocol: 'basket insertion' as const,
      insertionRemittance: {
        basket: TOKEN_BASKET,
        customInstructions: JSON.stringify({
          protocol: TOKEN_PROTOCOL,
          keyId: o.keyId,
          counterparty: o.counterparty,
        }),
        tags: o.tags,
      },
    })),
  });
}

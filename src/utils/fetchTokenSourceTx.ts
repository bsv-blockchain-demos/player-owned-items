import { Transaction, Beef } from '@bsv/sdk';
import type { WalletInterface } from '@bsv/sdk';
import { TOKEN_BASKET } from './internalizeToBasket';
import { getTransactionByTxID } from './overlayFunctions';

/**
 * Resolve a token's source transaction for spending: overlay first, then the
 * owner's wallet basket (which holds the full tx from internalize). Keeps spends
 * working even when the overlay hasn't indexed the tx.
 */
export async function fetchTokenSourceTx(wallet: WalletInterface, tokenId: string): Promise<Transaction> {
  const txid = tokenId.split('.')[0];

  try {
    const ov = await getTransactionByTxID(txid);
    const beef = ov?.outputs?.[0]?.beef;
    if (beef) return Transaction.fromBEEF(beef);
  } catch {
    // overlay unavailable — fall through to the wallet basket
  }

  const res = await wallet.listOutputs({ basket: TOKEN_BASKET, include: 'entire transactions' });
  const tx = res.BEEF ? Beef.fromBinary(res.BEEF).findAtomicTransaction(txid) : undefined;
  if (tx) return tx;

  throw new Error(`Could not resolve source tx for ${tokenId} (overlay + wallet basket both failed)`);
}

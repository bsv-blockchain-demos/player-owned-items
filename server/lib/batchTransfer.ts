// Checks a client batch transfer (posted as BEEF) before the server spends its outputs:
// each named outpoint must be an output of that tx, locked to the server key derived
// from the client's nonce N2, spending the owned token it stands for, with the amount expected,
// and inscribed with the same lootTableId as the owned DB doc.
import { P2PKH, Hash, type Transaction, type WalletInterface } from '@bsv/sdk';
import { TOKEN_PROTOCOL } from '@shared/tokenDerivation';
import { getServerPublicKey } from '@server/lib/serverWallet';
import { voutOf, transferAmount } from '@server/lib/materialUnits';
import { inscribedLootTableId } from '@server/lib/tokenScript';

/** Hex every transferred output's locking script must contain: P2PKH of the server key derived from N2. */
export async function serverLockPattern(
  serverWallet: Pick<WalletInterface, 'getPublicKey'>,
  transferNonce: string | undefined,
  userIdentityKey: string,
): Promise<string> {
  const key = transferNonce
    ? (await serverWallet.getPublicKey({ protocolID: TOKEN_PROTOCOL, keyID: transferNonce, counterparty: userIdentityKey, forSelf: true })).publicKey
    : await getServerPublicKey(); // legacy fallback
  // OrdinalsP2PKH embeds hash160(pubkey), not raw pubkey hex
  return new P2PKH().lock(Hash.hash160(key, 'hex')).toHex();
}

export interface ExpectedTransfer {
  label: string; // e.g. "Material common_wood", used in error messages
  tokenId: string; // outpoint in the batch tx
  ownedTokenId: string; // outpoint the batch must spend
  amount: number;
  amountRule: string; // e.g. "must carry amount 1"
  lootTableId: string; // the owned DB doc's; the output's metadata must name the same
}

/** The first reason the batch doesn't move each owned token whole to the server, or null. */
export function checkBatchTransfer(
  tx: Transaction,
  lockPattern: string,
  expected: ExpectedTransfer[],
): { status: 400 | 404; error: string } | null {
  const txid = tx.id('hex');
  const spent = new Set(tx.inputs.map((i) => `${i.sourceTXID || i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`));
  const seen = new Set<string>();
  for (const e of expected) {
    const vout = voutOf(e.tokenId, txid);
    if (vout === null) return { status: 400, error: `Transfer outpoint not in batch transfer: ${e.tokenId}` };
    if (seen.has(e.tokenId)) return { status: 400, error: `Transfer outpoint used twice: ${e.tokenId}` };
    seen.add(e.tokenId);
    const output = tx.outputs[vout];
    if (!output) return { status: 404, error: `Transfer output not found: ${e.tokenId}` };
    if (!output.lockingScript.toHex().includes(lockPattern)) return { status: 400, error: `${e.label} not locked to server derived key` };
    if (!spent.has(e.ownedTokenId)) return { status: 400, error: `${e.label} transfer does not spend owned token` };
    // A partial amount would leave the rest of the token untracked on chain.
    if (transferAmount(output.lockingScript) !== e.amount) return { status: 400, error: `${e.label} transfer ${e.amountRule}` };
    const inscribed = inscribedLootTableId(output.lockingScript);
    if (inscribed !== e.lootTableId) return { status: 400, error: `${e.label} transfer is inscribed as ${inscribed ?? 'no lootTableId'}` };
  }
  return null;
}

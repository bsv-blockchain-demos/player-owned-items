// Checks a client batch transfer (posted as BEEF) before the server spends its outputs:
// each named outpoint must be an output of that tx, locked to the server key derived
// from the client's nonce N2, carried by the input at the same index spending the owned
// token, with the amount expected, and inscribed with the owned DB doc's lootTableId and
// BSV-21 asset id (its mint outpoint). No other output may carry those assets.
import { P2PKH, Hash, type Transaction, type WalletInterface } from '@bsv/sdk';
import { TOKEN_PROTOCOL } from '@shared/tokenDerivation';
import { getServerPublicKey } from '@server/lib/serverWallet';
import { voutOf } from '@server/lib/materialUnits';
import { transferAmount, inscribedLootTableId, inscribedAssetId, mintAssetId } from '@server/lib/tokenScript';

/** The outpoint a transaction input spends. */
export function inputOutpoint(input: Transaction['inputs'][number]): string {
  return `${input.sourceTXID || input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}`;
}

/**
 * The first output outside `named` that carries one of `assetIds`, as an error, or null.
 * With each token on its own paired input/output, this keeps every transferred asset on
 * exactly one output: an extra one would mint units of it on chain (DB ignores it).
 */
export function strayAssetOutput(tx: Transaction, named: Set<number>, assetIds: Set<string>): string | null {
  for (let i = 0; i < tx.outputs.length; i++) {
    if (named.has(i)) continue;
    const id = inscribedAssetId(tx.outputs[i].lockingScript);
    if (id !== null && assetIds.has(id)) return `Output ${i} also carries asset ${id}`;
  }
  return null;
}

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
  mintOutpoint: string | undefined; // the owned DB doc's; the inscription's id must be its asset id
}

/** The first reason the batch doesn't move each owned token whole to the server, or null. */
export function checkBatchTransfer(
  tx: Transaction,
  lockPattern: string,
  expected: ExpectedTransfer[],
): { status: 400 | 404; error: string } | null {
  const txid = tx.id('hex');
  const seen = new Set<string>();
  const namedVouts = new Set<number>();
  const assetIds = new Set<string>();
  for (const e of expected) {
    const assetId = mintAssetId(e.mintOutpoint);
    if (!assetId) return { status: 400, error: `${e.label} has no recorded mint` };
    const vout = voutOf(e.tokenId, txid);
    if (vout === null) return { status: 400, error: `Transfer outpoint not in batch transfer: ${e.tokenId}` };
    if (seen.has(e.tokenId)) return { status: 400, error: `Transfer outpoint used twice: ${e.tokenId}` };
    seen.add(e.tokenId);
    const output = tx.outputs[vout];
    if (!output) return { status: 404, error: `Transfer output not found: ${e.tokenId}` };
    if (!output.lockingScript.toHex().includes(lockPattern)) return { status: 400, error: `${e.label} not locked to server derived key` };
    // Input i carries output i (clients build batches that way; wallet funding comes after).
    const paired = tx.inputs[vout];
    if (!paired || inputOutpoint(paired) !== e.ownedTokenId) return { status: 400, error: `${e.label} transfer does not spend owned token` };
    // A partial amount would leave the rest of the token untracked on chain.
    if (transferAmount(output.lockingScript) !== e.amount) return { status: 400, error: `${e.label} transfer ${e.amountRule}` };
    const inscribed = inscribedLootTableId(output.lockingScript);
    if (inscribed !== e.lootTableId) return { status: 400, error: `${e.label} transfer is inscribed as ${inscribed ?? 'no lootTableId'}` };
    const named = inscribedAssetId(output.lockingScript);
    if (named !== assetId) return { status: 400, error: `${e.label} transfer names asset ${named ?? 'none'}, not its mint ${assetId}` };
    namedVouts.add(vout);
    assetIds.add(assetId);
  }
  const stray = strayAssetOutput(tx, namedVouts, assetIds);
  return stray ? { status: 400, error: stray } : null;
}

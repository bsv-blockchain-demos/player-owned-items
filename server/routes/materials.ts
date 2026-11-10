// Single-tx mint: server builds/funds/signs one deploy+mint locked directly to
// the user's recipient-derived key (so mintOutpoint === tokenId). ALL wallet
// UTXO ops run through the serialized wallet queue (one mint at a time) to
// prevent concurrent double-spends. Returns the BEEF + nonce for the client to
// internalize into its wallet basket.

import { Router, type Request, type Response } from 'express';
import { Transaction, P2PKH, Beef, Hash } from '@bsv/sdk';
import { WalletP2PKH } from '@bsv/wallet-helper';
import { requireAuthProof } from '@server/middleware/requireAuthProof';
import { requireSession } from '@server/middleware/requireSession';
import { getWalletQueue } from '@server/lib/walletQueue';
import { connectToMongo } from '@server/lib/mongodb';
import { getServerWallet, getServerPublicKey, getServerIdentityPublicKey } from '@server/lib/serverWallet';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { broadcastTX } from '@shared/overlayFunctions';
import { decodeBeef, encodeBeef } from '@shared/beefEncoding';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey, deriveSelfKey } from '@shared/tokenDerivation';
import { getLootItemById } from '@shared/loot-table';
import {
  parseInventoryIds,
  isValidTier,
  claimMaterialUnits,
  releaseMaterialUnits,
  consumeMaterialUnits,
  claimTokens,
  releaseTokens,
  TOKEN_CLAIM_FAILED,
  anyTokenListed,
  TOKEN_LISTED,
  voutOf,
  transferAmount,
} from '@server/lib/materialUnits';

const CLAIM_FAILED = 'Inventory items missing or already being minted';

export const materialsRouter = Router();

materialsRouter.post('/mint-and-transfer', requireAuthProof('mint-material'), async (req: Request, res: Response) => {
  const userId = req.userId as string;

  // Per-step timing to localize mint latency (cumulative ms from request start).
  const t0 = Date.now();
  const step = (label: string) => console.log(`[materials:mint] ${label} +${Date.now() - t0}ms`);

  const { materials, userIdentityKey, paymentTx, walletParams } = req.body;

  // Validate materials array
  if (!materials || !Array.isArray(materials) || materials.length === 0) {
    res.status(400).json({ error: 'Invalid materials data' });
    return;
  }

  if (materials.length !== 1) {
    res.status(400).json({ error: 'Only one material token can be minted per request' });
    return;
  }

  if (!userIdentityKey) {
    res.status(400).json({ error: 'Missing user identity key' });
    return;
  }

  if (!paymentTx) {
    res.status(400).json({ error: 'Missing payment transaction' });
    return;
  }

  if (!walletParams || !walletParams.protocolID || !walletParams.keyID || !walletParams.counterparty) {
    res.status(400).json({ error: 'Missing wallet derivation parameters' });
    return;
  }

  // Quantity = owned inventory units; metadata = loot table. Body quantity/cosmetics are ignored.
  const requested = materials[0];
  const lootItem = getLootItemById(requested.lootTableId);
  if (!lootItem || lootItem.type !== 'material') {
    res.status(400).json({ error: `Not a material: ${requested.lootTableId}` });
    return;
  }
  const tier = requested.tier ?? 1;
  if (!isValidTier(tier)) {
    res.status(400).json({ error: 'Invalid tier' });
    return;
  }
  const inventoryIds = parseInventoryIds(requested.inventoryItemIds);
  if (!inventoryIds) {
    res.status(400).json({ error: 'Invalid inventoryItemIds' });
    return;
  }
  const material = {
    lootTableId: lootItem.lootId,
    itemName: lootItem.name,
    description: lootItem.description,
    icon: lootItem.icon,
    rarity: lootItem.rarity,
    tier,
    quantity: inventoryIds.length,
  };

  // Connect to MongoDB
  const { materialTokensCollection, userInventoryCollection } = await connectToMongo();

  // Decode payment BEEF (no wallet needed)
  const paymentBeef = decodeBeef(paymentTx);
  const paymentTransaction = Transaction.fromBEEF(paymentBeef);
  const paymentTxId = paymentTransaction.id('hex');
  const paymentOutput = paymentTransaction.outputs[0];
  if (!paymentOutput || !paymentOutput.satoshis || paymentOutput.satoshis < 100) {
    res.status(400).json({ error: 'Invalid payment: must be at least 100 satoshis' });
    return;
  }
  const paymentOutpoint = `${paymentTxId}.0`;
  step('validated + payment parsed');

  // Check for an existing token FIRST (before minting)
  const existingToken = await materialTokensCollection.findOne({
    userId,
    lootTableId: material.lootTableId,
    tier,
    consumed: { $ne: true },
  });

  if (existingToken) {
    res.status(409).json(
      {
        error: `Material token already exists`,
        details: `You already have a ${material.itemName} token. The system will now use the add-and-merge route to properly merge quantities on-chain.`,
        existingTokenId: existingToken.tokenId,
        existingQuantity: existingToken.quantity,
        lootTableId: material.lootTableId,
        tier,
        shouldUseAddAndMerge: true,
      },
    );
    return;
  }

  // ALL wallet UTXO-touching work runs inside the serialized queue, obtained before
  // claiming so a queue failure can't strand the claim.
  const queue = await getWalletQueue();

  const claimId = await claimMaterialUnits(userInventoryCollection, userId, material.lootTableId, tier, inventoryIds);
  if (!claimId) {
    res.status(409).json({ error: CLAIM_FAILED });
    return;
  }
  const mint = await queue.enqueue('mint:material', async (serverWallet) => {
    const walletp2pkh = new WalletP2PKH(serverWallet);
    const walletP2pkhUnlockTemplate = walletp2pkh.unlock({
      protocolID: walletParams.protocolID,
      keyID: walletParams.keyID,
      counterparty: walletParams.counterparty,
    });
    const walletP2pkhUnlockingLength = await walletP2pkhUnlockTemplate.estimateLength();

    const ordinalP2PKH = new OrdinalsP2PKH();
    const nonce = generateNonce();
    const serverIdentityKey = await getServerIdentityPublicKey();
    const userKey = await deriveRecipientKey(serverWallet, userIdentityKey, nonce);

    const materialMetadata = {
      name: 'material_token',
      lootTableId: material.lootTableId,
      itemName: material.itemName,
      description: material.description,
      icon: material.icon,
      rarity: material.rarity,
      tier: material.tier || 1,
      acquiredFrom: [],
    };

    const mintLockingScript = ordinalP2PKH.lock(userKey, '', materialMetadata, 'deploy+mint', material.quantity);
    step('derivation + locking script ready');

    const mintActionRes = await serverWallet.createAction({
      description: 'Server minting material token with user WalletP2PKH payment',
      inputBEEF: paymentBeef,
      inputs: [
        {
          inputDescription: 'User WalletP2PKH payment for fees',
          outpoint: paymentOutpoint,
          unlockingScriptLength: walletP2pkhUnlockingLength,
        },
      ],
      outputs: [
        {
          outputDescription: 'New material token',
          lockingScript: mintLockingScript.toHex(),
          satoshis: 1,
        },
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });
    if (!mintActionRes.signableTransaction) {
      throw new Error('Failed to create signable mint transaction');
    }
    step('createAction done');

    const mintReference = mintActionRes.signableTransaction.reference;
    const mintTxToSign = Transaction.fromBEEF(mintActionRes.signableTransaction.tx);
    mintTxToSign.inputs[0].unlockingScriptTemplate = walletP2pkhUnlockTemplate;
    mintTxToSign.inputs[0].sourceTransaction = paymentTransaction;
    await mintTxToSign.sign();
    step('local sign done');

    const mintUnlockingScript = mintTxToSign.inputs[0].unlockingScript;
    if (!mintUnlockingScript) {
      throw new Error('Missing unlocking script after signing');
    }

    const mintAction = await serverWallet.signAction({
      reference: mintReference,
      spends: { '0': { unlockingScript: mintUnlockingScript.toHex() } },
    });
    if (!mintAction.tx) {
      throw new Error('Failed to sign mint action');
    }
    step('signAction done (chain broadcast)');

    // Derive the txid locally from the signed tx — this IS what broadcastTX would
    // report (it also just computes tx.id('hex')), so no need to await the overlay
    // push here. The overlay push now happens off-path, after the response is sent.
    const mintTx = Transaction.fromAtomicBEEF(mintAction.tx);
    const mintTxId = mintTx.id('hex');
    if (!mintTxId) {
      throw new Error('Failed to derive transaction ID from signed tx');
    }
    step('signAction done — token ready, overlay push fired off-path');

    return {
      mintActionTx: mintAction.tx,
      tokenId: `${mintTxId}.0`, // mint proof and current location are the same outpoint
      nonce,
      serverIdentityKey,
    };
  }).catch(async (err) => {
    await releaseMaterialUnits(userInventoryCollection, claimId);
    throw err;
  });

  // DB writes are best-effort. The mint is already broadcast on-chain (signAction)
  // and the client will internalize the token into its basket, so a DB failure here
  // is recoverable via POST /mint-and-transfer/record. Never fail the response for it.
  // Units stay claimed on failure, so they can't be minted twice.
  let dbRecorded = false;
  let materialTokenId: string | undefined;
  try {
    const materialTokenDoc = {
      userId,
      lootTableId: material.lootTableId,
      itemName: material.itemName,
      tier,
      tokenId: mint.tokenId,
      quantity: material.quantity,
      metadata: {
        name: 'material_token',
        lootTableId: material.lootTableId,
        itemName: material.itemName,
        description: material.description,
        icon: material.icon,
        rarity: material.rarity,
        tier,
        acquiredFrom: [],
      },
      mintOutpoint: mint.tokenId,
      keyId: mint.nonce,
      counterparty: mint.serverIdentityKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const materialResult = await materialTokensCollection.insertOne(materialTokenDoc);
    materialTokenId = materialResult.insertedId.toString();

    await consumeMaterialUnits(userInventoryCollection, claimId);

    dbRecorded = true;
    step('db written');
  } catch (dbErr) {
    materialTokenId = undefined;
    console.error('[materials:mint] DB write failed (token is on-chain + will be internalized; repairable):', dbErr);
  }

  res.json({
    success: true,
    dbRecorded,
    results: [
      {
        lootTableId: material.lootTableId,
        tokenId: mint.tokenId,
        mintOutpoint: mint.tokenId,
        quantity: material.quantity,
        materialTokenId,
        updated: false,
      },
    ],
    transferBeef: encodeBeef(Array.from(mint.mintActionTx as Uint8Array)),
    received: {
      outputIndex: 0,
      keyId: mint.nonce,
      counterparty: mint.serverIdentityKey,
      tags: ['type:material'],
    },
  });

  // Fire-and-forget overlay push, off the response path and outside the wallet
  // queue lock. The token is already on-chain (signAction); this only speeds up
  // overlay-based lookups.
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(mint.mintActionTx)))
    .catch((e) => {
      console.error('[materials:mint] overlay broadcast failed (non-blocking):', e);
    });
});

// Server-side material add-and-merge (derived-key pattern).
// Client transfers its token to the server (posted BEEF + nonce), then calls this route.
// Server unlocks the transferred token, mints the added quantity, merges both into one
// output locked to the user's recipient-derived key, and returns the BEEF + nonce.
// The mint + merge are one dependent sequence and run as a single unit through the
// serialized wallet queue to prevent concurrent UTXO double-spends.
materialsRouter.post('/add-and-merge', requireAuthProof('merge-material'), async (req: Request, res: Response) => {
  const userId = req.userId as string;

  // Per-step timing to localize merge latency (cumulative ms from request start).
  const t0 = Date.now();
  const step = (label: string) => console.log(`[materials:merge] ${label} +${Date.now() - t0}ms`);

  const {
    transferredTokenId,  // 'txid.vout' of the transferred (server-owned) output
    transferBeef,        // base64 BEEF of client's transfer tx (NEW — replaces overlay fetch)
    transferNonce,       // N2: nonce client used to lock to server; absent ⇒ legacy token
    userIdentityKey,     // replaces userPublicKey; derivation counterparty
    lootTableId,
    itemName,
    tier = 1,
    currentQuantity,
    paymentTx,           // base64 WalletP2PKH payment BEEF
    walletParams,
    reason,
    inventoryItemIds,    // unminted UserInventory items being merged in (to consume)
  } = req.body;

  // Validate required fields
  if (!transferredTokenId || !lootTableId || !itemName || !userIdentityKey || !transferBeef) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  if (!paymentTx) {
    res.status(400).json({ error: 'Missing payment transaction' });
    return;
  }

  if (!walletParams || !walletParams.protocolID || !walletParams.keyID || !walletParams.counterparty) {
    res.status(400).json({ error: 'Missing wallet derivation parameters' });
    return;
  }

  // Added quantity = owned inventory units; metadata = loot table. Body quantity/cosmetics are ignored.
  const lootItem = getLootItemById(lootTableId);
  if (!lootItem || lootItem.type !== 'material') {
    res.status(400).json({ error: `Not a material: ${lootTableId}` });
    return;
  }

  if (!isValidTier(tier)) {
    res.status(400).json({ error: 'Invalid tier' });
    return;
  }

  const inventoryIds = parseInventoryIds(inventoryItemIds);
  if (!inventoryIds) {
    res.status(400).json({ error: 'Invalid inventoryItemIds' });
    return;
  }
  const addedQuantity = inventoryIds.length;

  if (currentQuantity <= 0 || !Number.isInteger(currentQuantity)) {
    res.status(400).json({ error: `Invalid currentQuantity: ${currentQuantity}` });
    return;
  }

  // Connect to MongoDB
  const { materialTokensCollection, userInventoryCollection, marketplaceItemsCollection } = await connectToMongo();

  // Pre-lock read: this only needs a wallet handle for getPublicKey (no UTXO ops), so it's
  // safe outside the serialized queue. Same singleton wallet the queue itself uses.
  const serverWallet = await getServerWallet();
  const ordinalP2PKH = new OrdinalsP2PKH();

  // Decode and parse payment transaction
  const paymentBeef = decodeBeef(paymentTx);
  const paymentTransaction = Transaction.fromBEEF(paymentBeef);
  const paymentTxId = paymentTransaction.id('hex');

  const paymentOutput = paymentTransaction.outputs[0];
  if (!paymentOutput || !paymentOutput.satoshis || paymentOutput.satoshis < 100) {
    res.status(400).json({ error: 'Invalid payment: must be at least 100 satoshis' });
    return;
  }

  const paymentOutpoint = `${paymentTxId}.0`;
  step('validated + payment parsed');

  const walletp2pkh = new WalletP2PKH(serverWallet);
  const walletP2pkhUnlockTemplate = walletp2pkh.unlock({
    protocolID: walletParams.protocolID,
    keyID: walletParams.keyID,
    counterparty: walletParams.counterparty,
  });
  const walletP2pkhUnlockingLength = await walletP2pkhUnlockTemplate.estimateLength();

  // Validate the transferred token from the posted BEEF (no overlay).

  const transferTransaction = Transaction.fromBEEF(decodeBeef(transferBeef));

  const transferOutputIndex = voutOf(String(transferredTokenId), transferTransaction.id('hex'));
  if (transferOutputIndex === null) {
    res.status(400).json({ error: `Transfer outpoint not in transfer transaction: ${transferredTokenId}` });
    return;
  }
  const transferOutput = transferTransaction.outputs[transferOutputIndex];

  if (!transferOutput) {
    res.status(404).json({ error: 'Transfer output not found' });
    return;
  }

  // Validate transfer output is locked to the server-derived key the client addressed
  const transferScriptHex = transferOutput.lockingScript.toHex();
  const expectedServerKey = transferNonce
    ? (await serverWallet.getPublicKey({
        protocolID: TOKEN_PROTOCOL,
        keyID: transferNonce,
        counterparty: userIdentityKey,
        forSelf: true,
      })).publicKey
    : await getServerPublicKey(); // legacy fallback (fixed key)
  // P2PKH.lock needs the pubkey HASH (or a base58 address), not a raw pubkey hex —
  // OrdinalsP2PKH embeds hash160(pubkey), so hash before comparing.
  const expectedScriptPattern = new P2PKH().lock(Hash.hash160(expectedServerKey, 'hex')).toHex();

  if (!transferScriptHex.includes(expectedScriptPattern)) {
    res.status(400).json({ error: 'Transfer output not locked to server public key' });
    return;
  }

  // The merged token is the one the transfer spends; a user may hold several per material + tier
  // (e.g. after a marketplace purchase). A junk transfer finds nothing to merge into.
  const spentOutpoints = transferTransaction.inputs.map(
    (i) => `${i.sourceTXID || i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`,
  );
  const existingToken = await materialTokensCollection.findOne({
    userId,
    lootTableId,
    tier,
    consumed: { $ne: true },
    tokenId: { $in: spentOutpoints },
  });

  if (!existingToken) {
    res.status(404).json({ error: 'Material token not found or already consumed' });
    return;
  }

  if (existingToken.quantity !== currentQuantity) {
    res.status(409).json({ error: `Quantity mismatch: expected ${existingToken.quantity}, got ${currentQuantity}` });
    return;
  }

  // A partial amount would leave the rest of the token untracked on chain.
  if (transferAmount(transferOutput.lockingScript) !== existingToken.quantity) {
    res.status(400).json({ error: `Transfer must carry the full token quantity (${existingToken.quantity})` });
    return;
  }

  if (await anyTokenListed(marketplaceItemsCollection, [existingToken._id])) {
    res.status(409).json({ error: TOKEN_LISTED });
    return;
  }

  const materialMetadata = {
    name: 'material_token',
    lootTableId: lootItem.lootId,
    itemName: lootItem.name,
    description: lootItem.description,
    icon: lootItem.icon,
    rarity: lootItem.rarity,
    tier,
    acquiredFrom: [],
  };

  // Obtained before claiming so a queue failure can't strand the claims.
  const queue = await getWalletQueue();

  const tokenClaimId = await claimTokens(materialTokensCollection, userId, [
    { _id: existingToken._id, tokenId: existingToken.tokenId },
  ]);
  if (!tokenClaimId) {
    res.status(409).json({ error: TOKEN_CLAIM_FAILED });
    return;
  }
  const claimId = await claimMaterialUnits(userInventoryCollection, userId, lootItem.lootId, tier, inventoryIds);
  if (!claimId) {
    await releaseTokens(materialTokensCollection, tokenClaimId);
    res.status(409).json({ error: CLAIM_FAILED });
    return;
  }

  // Both dependent wallet actions (mint the added quantity, then merge it with the
  // transferred token) run as ONE serialized unit through the wallet queue.
  const merge = await queue.enqueue('merge:material', async (serverWallet) => {
    // Mint the added quantity to a self-derived key.

    const mintNonce = generateNonce();
    const mintKey = await deriveSelfKey(serverWallet, mintNonce);
    const mintLockingScript = ordinalP2PKH.lock(mintKey, '', materialMetadata, 'deploy+mint', addedQuantity);

    const mintActionRes = await serverWallet.createAction({
      description: "Minting additional materials for merge with user WalletP2PKH payment",
      inputBEEF: paymentBeef,
      inputs: [{
        inputDescription: "User WalletP2PKH payment for fees",
        outpoint: paymentOutpoint,
        unlockingScriptLength: walletP2pkhUnlockingLength,
      }],
      outputs: [{
        outputDescription: "New material token (self-derived key)",
        lockingScript: mintLockingScript.toHex(),
        satoshis: 1,
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });

    if (!mintActionRes.signableTransaction) {
      throw new Error('Failed to create signable mint transaction');
    }
    step('createAction done (mint)');

    const mintReference = mintActionRes.signableTransaction.reference;
    const mintTxToSign = Transaction.fromBEEF(mintActionRes.signableTransaction.tx);

    mintTxToSign.inputs[0].unlockingScriptTemplate = walletP2pkhUnlockTemplate;
    mintTxToSign.inputs[0].sourceTransaction = paymentTransaction;
    await mintTxToSign.sign();
    step('local sign done (mint)');

    const mintUnlockingScript = mintTxToSign.inputs[0].unlockingScript;
    if (!mintUnlockingScript) throw new Error('Missing unlocking script after signing');

    const mintAction = await serverWallet.signAction({
      reference: mintReference,
      spends: { '0': { unlockingScript: mintUnlockingScript.toHex() } },
    });

    if (!mintAction.tx) throw new Error('Failed to sign mint action');
    step('signAction done (mint) — token ready, overlay push fired off-path');

    // Derive the txid locally from the signed tx — this IS what broadcastTX would
    // report (it also just computes tx.id('hex')). The overlay push for this
    // intermediate tx now happens off-path, after the response is sent.
    const mintTx = Transaction.fromAtomicBEEF(mintAction.tx);
    const mintTxId = mintTx.id('hex');
    const mintOutpoint = `${mintTxId}.0`;

    // Merge both tokens into one output locked to the user's recipient-derived key.

    const serverIdentityKey = await getServerIdentityPublicKey();
    const N3 = generateNonce();
    const userKey = await deriveRecipientKey(serverWallet, userIdentityKey, N3);

    const newQuantity = currentQuantity + addedQuantity;
    const mergedAssetId = mintOutpoint.replace('.', '_');

    const mergeLockingScript = ordinalP2PKH.lock(userKey, mergedAssetId, materialMetadata, 'transfer', newQuantity);

    // Two separate unlock templates — each has its own derivation
    const transferredUnlock = ordinalP2PKH.unlock(
      serverWallet, 'all', false, undefined, undefined,
      transferNonce
        ? { protocolID: TOKEN_PROTOCOL, keyID: transferNonce, counterparty: userIdentityKey }
        : undefined  // legacy: no derivation override (uses fixed key)
    );
    const mintedUnlock = ordinalP2PKH.unlock(
      serverWallet, 'all', false, undefined, undefined,
      { protocolID: TOKEN_PROTOCOL, keyID: mintNonce, counterparty: 'self' }
    );

    const transferredUnlockLength = await transferredUnlock.estimateLength();
    const mintedUnlockLength = await mintedUnlock.estimateLength();

    const mergedBeef = new Beef();
    mergedBeef.mergeBeef(transferTransaction.toBEEF());
    mergedBeef.mergeBeef(mintTx.toBEEF());
    const inputBEEF = mergedBeef.toBinary();

    const mergeActionRes = await serverWallet.createAction({
      description: "Merging material tokens",
      inputBEEF,
      inputs: [
        {
          inputDescription: "Transferred token from user",
          outpoint: transferredTokenId,
          unlockingScriptLength: transferredUnlockLength,
        },
        {
          inputDescription: "Newly minted token",
          outpoint: mintOutpoint,
          unlockingScriptLength: mintedUnlockLength,
        },
      ],
      outputs: [{
        outputDescription: "Merged token to user recipient-derived key",
        lockingScript: mergeLockingScript.toHex(),
        satoshis: 1,
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });

    if (!mergeActionRes.signableTransaction) {
      throw new Error('Failed to create signable merge transaction');
    }
    step('createAction done (merge)');

    const reference = mergeActionRes.signableTransaction.reference;
    const txToSign = Transaction.fromBEEF(mergeActionRes.signableTransaction.tx);

    txToSign.inputs[0].unlockingScriptTemplate = transferredUnlock;
    txToSign.inputs[0].sourceTransaction = transferTransaction;
    txToSign.inputs[1].unlockingScriptTemplate = mintedUnlock;
    txToSign.inputs[1].sourceTransaction = mintTx;

    await txToSign.sign();
    step('local sign done (merge)');

    const unlockingScript0 = txToSign.inputs[0].unlockingScript;
    const unlockingScript1 = txToSign.inputs[1].unlockingScript;

    if (!unlockingScript0 || !unlockingScript1) {
      throw new Error('Missing unlocking scripts after signing');
    }

    const mergeAction = await serverWallet.signAction({
      reference,
      spends: {
        '0': { unlockingScript: unlockingScript0.toHex() },
        '1': { unlockingScript: unlockingScript1.toHex() },
      },
    });

    if (!mergeAction.tx) throw new Error('Failed to sign merge action');
    step('signAction done (merge) — token ready, overlay pushes fired off-path');

    // Derive locally — same value broadcastTX would report.
    const mergeTx = Transaction.fromAtomicBEEF(mergeAction.tx);
    const mergeTxId = mergeTx.id('hex');
    const mergedTokenId = `${mergeTxId}.0`;

    return {
      mintActionTx: mintAction.tx, // intermediate mint tx — pushed off-path too (Change 1, two-action route)
      mergeActionTx: mergeAction.tx,
      mergedTokenId,
      mergeTxId,
      N3,
      serverIdentityKey,
      mintOutpoint,
      transferredTokenId,
    };
  }).catch(async (err) => {
    await releaseMaterialUnits(userInventoryCollection, claimId);
    await releaseTokens(materialTokensCollection, tokenClaimId);
    throw err;
  });

  // DB writes are best-effort: the merge is already on chain, so the client always
  // gets the BEEF. On failure both claims stay held, since the token is spent and
  // the units are inscribed, so neither may be offered again.
  let dbRecorded = false;
  try {
    const { modifiedCount } = await materialTokensCollection.updateOne(
      { _id: existingToken._id, userId, tokenId: existingToken.tokenId, pendingClaim: tokenClaimId },
      {
        $unset: { pendingClaim: '' },
        $set: {
          tokenId: merge.mergedTokenId,
          quantity: currentQuantity + addedQuantity,
          metadata: materialMetadata,
          previousTokenId: transferredTokenId,
          lastTransactionId: merge.mergeTxId,
          keyId: merge.N3,
          counterparty: merge.serverIdentityKey,
          updatedAt: new Date(),
        },
        $push: {
          updateHistory: {
            operation: 'add',
            previousQuantity: currentQuantity,
            newQuantity: currentQuantity + addedQuantity,
            transactionId: merge.mergeTxId,
            mergedFrom: [transferredTokenId, merge.mintOutpoint],
            reason: reason || 'Material addition (server merge)',
            timestamp: new Date(),
          },
        },
      }
    );
    if (modifiedCount !== 1) console.error(`[materials:merge] token ${existingToken.tokenId} not updated (claim lost)`);

    // Consume the unminted UserInventory items that fed the added quantity.
    await consumeMaterialUnits(userInventoryCollection, claimId);
    dbRecorded = true;
    step('db written');
  } catch (dbErr) {
    console.error(`[materials:merge] DB write failed after on-chain merge ${merge.mergeTxId} (claims held):`, dbErr);
  }

  res.json({
    success: true,
    dbRecorded,
    mergedTokenId: merge.mergedTokenId,
    mergeTransactionId: merge.mergeTxId,
    newQuantity: currentQuantity + addedQuantity,
    previousQuantity: currentQuantity,
    addedQuantity,
    transferBeef: encodeBeef(Array.from(merge.mergeActionTx as Uint8Array)),
    received: {
      outputIndex: 0,
      keyId: merge.N3,
      counterparty: merge.serverIdentityKey,
      tags: ['type:material'],
    },
  });

  // Fire-and-forget overlay pushes for BOTH txs (intermediate mint + final merge),
  // off the response path and outside the wallet queue lock. Both are already
  // on-chain (signAction); this only speeds up overlay-based lookups.
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(merge.mintActionTx)))
    .catch((e) => {
      console.error('[materials:merge] overlay broadcast (mint) failed (non-blocking):', e);
    });
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(merge.mergeActionTx)))
    .catch((e) => {
      console.error('[materials:merge] overlay broadcast (merge) failed (non-blocking):', e);
    });
});

// Check whether a (non-consumed) material token already exists for this user/lootTableId/tier.
materialsRouter.post('/check-token', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;

    const { lootTableId, tier } = req.body;

    if (!lootTableId || !tier) {
      res.status(400).json({ error: 'Missing lootTableId or tier' });
      return;
    }

    const { materialTokensCollection } = await connectToMongo();

    const existingToken = await materialTokensCollection.findOne({
      userId,
      lootTableId,
      tier,
      consumed: { $ne: true },
    });

    if (existingToken) {
      res.json({
        exists: true,
        token: {
          tokenId: existingToken.tokenId,
          quantity: existingToken.quantity,
          keyId: existingToken.keyId,
          counterparty: existingToken.counterparty,
        },
      });
    } else {
      res.json({
        exists: false,
      });
    }
  } catch (error) {
    console.error('Error checking material token:', error);
    res.status(500).json({ error: 'Failed to check material token' });
  }
});

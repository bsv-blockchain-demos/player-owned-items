// Single-tx mint: server builds/funds/signs one deploy+mint locked directly to
// the user's recipient-derived key (so mintOutpoint === tokenId). ALL wallet
// UTXO ops run through the serialized wallet queue (one mint at a time) to
// prevent concurrent double-spends. Returns the BEEF + nonce for the client to
// internalize into its wallet basket.

import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import { Transaction } from '@bsv/sdk';
import { WalletP2PKH } from '@bsv/wallet-helper';
import { requireAuthProof } from '@server/middleware/requireAuthProof';
import { requireSession } from '@server/middleware/requireSession';
import { getWalletQueue } from '@server/lib/walletQueue';
import { connectToMongo } from '@server/lib/mongodb';
import { getServerIdentityPublicKey, getServerWallet } from '@server/lib/serverWallet';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { broadcastTX } from '@shared/overlayFunctions';
import { decodeBeef, encodeBeef } from '@shared/beefEncoding';
import { generateNonce, deriveRecipientKey } from '@shared/tokenDerivation';
import { getLootItemById } from '@shared/loot-table';
import type { UserInventory } from '@shared/types';

export const itemsRouter = Router();

// Material units are counted into material tokens; minting one as an NFT would let it be both.
const MATERIAL_NOT_ITEM = 'Materials are minted as material tokens';
const isMaterial = (item: UserInventory) =>
  item.itemType === 'material' || getLootItemById(item.lootTableId)?.type === 'material';

itemsRouter.post('/mint-and-transfer', requireAuthProof('mint-item'), async (req: Request, res: Response) => {
  const userId = req.userId as string; // set by requireAuthProof

  // Per-step timing to localize mint latency (cumulative ms from request start).
  const t0 = Date.now();
  const step = (label: string) => console.log(`[items:mint] ${label} +${Date.now() - t0}ms`);

  const { inventoryItemId, itemData, userIdentityKey, paymentTx, walletParams } = req.body;

  // Validate required fields
  if (!inventoryItemId || !itemData || !userIdentityKey) {
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

  // Connect to MongoDB and validate ownership
  const { userInventoryCollection, nftLootCollection } = await connectToMongo();
  const inventoryItem = await userInventoryCollection.findOne({
    _id: new ObjectId(inventoryItemId),
    userId,
  });
  if (!inventoryItem) {
    res.status(404).json({ error: 'Item not found or not owned by user' });
    return;
  }
  if (isMaterial(inventoryItem)) {
    res.status(400).json({ error: MATERIAL_NOT_ITEM });
    return;
  }
  if (inventoryItem.nftLootId) {
    res.status(400).json({ error: 'Item already minted' });
    return;
  }

  // Decode payment BEEF (no wallet needed)
  const paymentBeef = decodeBeef(paymentTx);
  const paymentTransaction = Transaction.fromBEEF(paymentBeef);
  const paymentTxId = paymentTransaction.id('hex');
  const paymentOutput = paymentTransaction.outputs[0];
  if (!paymentOutput || !paymentOutput.satoshis || paymentOutput.satoshis < 90) {
    res.status(400).json({ error: 'Invalid payment: must be at least 100 (10% variance) satoshis' });
    return;
  }
  const paymentOutpoint = `${paymentTxId}.0`;
  step('validated + payment parsed');

  // ALL wallet UTXO-touching work runs inside the serialized queue.
  const queue = await getWalletQueue();
  const mint = await queue.enqueue('mint:item', async (serverWallet) => {
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
    const mintLockingScript = ordinalP2PKH.lock(userKey, '', itemData, 'deploy+mint');
    step('derivation + locking script ready');

    const mintActionRes = await serverWallet.createAction({
      description: 'Server minting item NFT with user WalletP2PKH payment',
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
          outputDescription: 'New NFT item',
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
  });

  // DB writes are best-effort. The mint is already broadcast on-chain (signAction)
  // and the client will internalize the token into its basket, so a DB failure here
  // is recoverable via POST /mint-and-transfer/record. Never fail the response for it.
  let dbRecorded = false;
  let nftLootId: string | undefined;
  try {
    const nftLootDoc = {
      lootTableId: inventoryItem.lootTableId,
      name: itemData.name || itemData.itemName,
      description: itemData.description,
      icon: itemData.icon,
      rarity: itemData.rarity,
      type: inventoryItem.itemType,
      attributes: itemData,
      mintOutpoint: mint.tokenId,
      tokenId: mint.tokenId,
      createdAt: new Date(),
    };
    const nftResult = await nftLootCollection.insertOne(nftLootDoc);
    nftLootId = nftResult.insertedId.toString();

    await userInventoryCollection.updateOne(
      { _id: new ObjectId(inventoryItemId) },
      {
        $set: {
          nftLootId: nftResult.insertedId,
          mintOutpoint: mint.tokenId,
          tokenId: mint.tokenId,
          keyId: mint.nonce,
          counterparty: mint.serverIdentityKey,
          updatedAt: new Date(),
        },
      },
    );
    dbRecorded = true;
    step('db written');
  } catch (dbErr) {
    nftLootId = undefined; // insert may have succeeded but the link failed — don't report a half-write
    console.error('[items:mint] DB write failed (token is on-chain + will be internalized; repairable via /record):', dbErr);
  }

  res.json({
    success: true,
    dbRecorded,
    nftId: nftLootId,
    tokenId: mint.tokenId,
    mintOutpoint: mint.tokenId,
    transferBeef: encodeBeef(Array.from(mint.mintActionTx as Uint8Array)),
    received: {
      outputIndex: 0,
      keyId: mint.nonce,
      counterparty: mint.serverIdentityKey,
      tags: ['type:item'],
    },
  });

  // Fire-and-forget overlay push, off the response path and outside the wallet
  // queue lock. The token is already on-chain (signAction); this only speeds up
  // overlay-based lookups (basket + /record reconcile cover any gap).
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(mint.mintActionTx)))
    .catch((e) => {
      console.error('[items:mint] overlay broadcast failed (non-blocking):', e);
    });
});

// Repair the DB after a mint whose on-chain broadcast succeeded but whose DB write
// failed. The wallet basket holds the token (source of truth); this route verifies
// the claimed outpoint is a server mint locked to the session user, then re-writes
// the DB. Guarded by requireSession — the provenance check is the real guard.
itemsRouter.post('/mint-and-transfer/record', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId as string; // BSV identity key of the session user
  const { inventoryItemId, transferBeef, outpoint, keyId, itemData } = req.body;

  if (!inventoryItemId || !transferBeef || !outpoint || !keyId || !itemData) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const { userInventoryCollection, nftLootCollection, materialTokensCollection } = await connectToMongo();
  const inventoryItem = await userInventoryCollection.findOne({
    _id: new ObjectId(inventoryItemId),
    userId,
  });
  if (!inventoryItem) {
    res.status(404).json({ error: 'Item not found or not owned by user' });
    return;
  }
  if (inventoryItem.nftLootId) {
    res.status(200).json({ success: true, alreadyRecorded: true, nftId: inventoryItem.nftLootId.toString() });
    return;
  }
  if (isMaterial(inventoryItem)) {
    res.status(400).json({ error: MATERIAL_NOT_ITEM });
    return;
  }
  // A quantity-1 material token mint has the same lock shape as an item mint.
  if (itemData?.name !== 'game_item') {
    res.status(400).json({ error: 'Not an item mint' });
    return;
  }

  // Prevent replaying one legit mint across multiple items (fee bypass):
  // reject if this outpoint is already attributed to an inventory item.
  const alreadyAttributed =
    (await userInventoryCollection.findOne({ tokenId: outpoint })) ??
    (await materialTokensCollection.findOne({ $or: [{ tokenId: outpoint }, { mintOutpoint: outpoint }] }));
  if (alreadyAttributed) {
    res.status(409).json({ error: 'This mint is already recorded to an item' });
    return;
  }

  // Verify provenance: the tx output at `outpoint` must be the ordinal mint the SERVER
  // would produce for THIS user (derived key) with THIS itemData. Only the server can
  // create that lock (ECDH via the server wallet), so a match is unforgeable.
  const [txid, voutStr] = String(outpoint).split('.');
  const vout = Number(voutStr);
  const tx = Transaction.fromAtomicBEEF(decodeBeef(transferBeef));
  if (tx.id('hex') !== txid) {
    res.status(400).json({ error: 'Outpoint does not match the provided transaction' });
    return;
  }
  const onChainScript = tx.outputs[vout]?.lockingScript?.toHex();

  const serverWallet = await getServerWallet();
  const userKey = await deriveRecipientKey(serverWallet, userId, keyId);
  const expectedScript = new OrdinalsP2PKH().lock(userKey, '', itemData, 'deploy+mint').toHex();

  if (!onChainScript || onChainScript !== expectedScript) {
    res.status(400).json({ error: 'Outpoint is not a server mint locked to this user' });
    return;
  }

  // Provenance verified — write the same records the happy path writes.
  const serverIdentityKey = await getServerIdentityPublicKey();
  const nftLootDoc = {
    lootTableId: inventoryItem.lootTableId,
    name: itemData.name || itemData.itemName,
    description: itemData.description,
    icon: itemData.icon,
    rarity: itemData.rarity,
    type: inventoryItem.itemType,
    attributes: itemData,
    mintOutpoint: outpoint,
    tokenId: outpoint,
    createdAt: new Date(),
  };
  const nftResult = await nftLootCollection.insertOne(nftLootDoc);

  await userInventoryCollection.updateOne(
    { _id: new ObjectId(inventoryItemId) },
    {
      $set: {
        nftLootId: nftResult.insertedId,
        mintOutpoint: outpoint,
        tokenId: outpoint,
        keyId,
        counterparty: serverIdentityKey,
        updatedAt: new Date(),
      },
    },
  );

  res.json({ success: true, dbRecorded: true, nftId: nftResult.insertedId.toString(), tokenId: outpoint });
});

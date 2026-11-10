// Server-side equipment update with inscription scrolls (batched derived-key pattern).
// Client transfers equipment + scrolls in one batch tx (posted BEEF + shared nonce N2).
// The server reads the item and scrolls from the user's owned minted docs + loot table and
// checks the batch moves exactly those tokens to it, so the body can't forge identity.
// Server unlocks all transferred inputs with a single shared-derivation template,
// applies inscriptions, and outputs updated equipment to user's recipient-derived key (N3).
// Scrolls are consumed (no output). ALL wallet UTXO ops run through the serialized wallet
// queue (one action at a time) to prevent concurrent double-spends. Returns BEEF + N3 for
// the client to internalize.

import { Router, type Request, type Response } from 'express';
import { ObjectId, type WithId } from 'mongodb';
import { Transaction, Beef } from '@bsv/sdk';
import { WalletP2PKH } from '@bsv/wallet-helper';
import { requireAuthProof } from '@server/middleware/requireAuthProof';
import { requireSession } from '@server/middleware/requireSession';
import { getWalletQueue } from '@server/lib/walletQueue';
import { connectToMongo } from '@server/lib/mongodb';
import { getServerWallet, getServerIdentityPublicKey } from '@server/lib/serverWallet';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { broadcastTX } from '@shared/overlayFunctions';
import { decodeBeef, encodeBeef } from '@shared/beefEncoding';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey } from '@shared/tokenDerivation';
import { getLootItemById } from '@shared/loot-table';
import { EQUIPMENT_SLOTS, type Inscription, type InscriptionData, type UserInventory } from '@shared/types';
import { serverLockPattern, checkBatchTransfer } from '@server/lib/batchTransfer';
import { mintAssetId } from '@server/lib/tokenScript';
import { EXCLUSIVE_INSCRIPTION_TYPES } from '@shared/inscriptions';
import {
  parseInventoryIds,
  claimTokens,
  releaseTokens,
  anyTokenListed,
  ITEM_LISTED,
  TOKEN_CLAIM_FAILED,
} from '@server/lib/materialUnits';

export const equipmentRouter = Router();

const INSCRIBABLE_TYPES = ['weapon', 'armor', 'artifact'];

equipmentRouter.post('/update', requireAuthProof('update-equipment'), async (req: Request, res: Response) => {
  const userId = req.userId as string;

  // Per-step timing to localize update latency (cumulative ms from request start).
  const t0 = Date.now();
  const step = (label: string) => console.log(`[equipment:update] ${label} +${Date.now() - t0}ms`);

  // Item identity, stats and inscriptions come from the owned docs + loot table, never the body.
  const {
    originalEquipmentInventoryId,
    inscriptionScrollInventoryIds,   // Array of scroll inventory IDs
    transferredEquipmentTokenId,     // equipment's outpoint in the batch transfer tx
    transferredScrollTokenIds,       // scroll outpoints in the batch transfer tx, same order as the ids
    batchTransferBeef,               // base64 BEEF of client's batch transfer tx
    transferNonce,                   // N2: shared nonce used to lock all transferred outputs to server; absent ⇒ legacy
    userIdentityKey,                 // Derivation counterparty
    paymentTx,                       // base64 WalletP2PKH payment BEEF
    walletParams,
  } = req.body;

  if (!originalEquipmentInventoryId || !inscriptionScrollInventoryIds || !transferredEquipmentTokenId || !transferredScrollTokenIds || !userIdentityKey || !batchTransferBeef) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  if (!Array.isArray(inscriptionScrollInventoryIds) || inscriptionScrollInventoryIds.length === 0) {
    res.status(400).json({ error: 'At least one inscription scroll required' });
    return;
  }

  if (inscriptionScrollInventoryIds.length > 2) {
    res.status(400).json({ error: 'Maximum 2 inscription scrolls allowed (prefix + suffix)' });
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

  const itemIds = parseInventoryIds([originalEquipmentInventoryId, ...inscriptionScrollInventoryIds]);
  const transferOutpoints = [transferredEquipmentTokenId, ...(Array.isArray(transferredScrollTokenIds) ? transferredScrollTokenIds : [])];
  if (
    !itemIds ||
    transferOutpoints.length !== itemIds.length ||
    !transferOutpoints.every((outpoint) => typeof outpoint === 'string')
  ) {
    res.status(400).json({ error: 'Invalid equipment or scroll ids' });
    return;
  }
  const [equipmentId, ...scrollIds] = itemIds;

  const { userInventoryCollection, nftLootCollection, playerStatsCollection, marketplaceItemsCollection } = await connectToMongo();
  const findMinted = (_id: ObjectId) =>
    userInventoryCollection.findOne({ _id, userId, nftLootId: { $type: 'objectId' }, tokenId: { $type: 'string' } });

  const originalEquipment = await findMinted(equipmentId);
  if (!originalEquipment) {
    res.status(404).json({ error: 'Original equipment not found or not owned by user' });
    return;
  }
  const equipmentLoot = getLootItemById(originalEquipment.lootTableId);
  if (!equipmentLoot || !INSCRIBABLE_TYPES.includes(equipmentLoot.type)) {
    res.status(400).json({ error: 'Only weapons, armor, and artifacts can be inscribed' });
    return;
  }

  const scrolls: Array<{ doc: WithId<UserInventory>; data: InscriptionData }> = [];
  for (const scrollId of scrollIds) {
    const doc = await findMinted(scrollId);
    if (!doc) {
      res.status(404).json({ error: 'One or more inscription scrolls not found or not owned by user' });
      return;
    }
    const scrollLoot = getLootItemById(doc.lootTableId);
    if (scrollLoot?.type !== 'inscription_scroll' || !scrollLoot.inscriptionData) {
      res.status(400).json({ error: 'Selected item is not an inscription scroll' });
      return;
    }
    scrolls.push({ doc, data: scrollLoot.inscriptionData });
  }
  if (new Set(scrolls.map((s) => s.data.slot)).size !== scrolls.length) {
    res.status(400).json({ error: 'One inscription scroll per slot' });
    return;
  }

  // Each scroll replaces its slot; an untouched slot keeps its inscription.
  let updatedPrefix: Inscription | null = originalEquipment.prefix ?? null;
  let updatedSuffix: Inscription | null = originalEquipment.suffix ?? null;
  for (const { data } of scrolls) {
    const inscription: Inscription = { type: data.inscriptionType, value: data.statValue, name: data.name };
    if (data.slot === 'prefix') updatedPrefix = inscription;
    else updatedSuffix = inscription;
  }
  if (updatedPrefix && updatedSuffix && updatedPrefix.type === updatedSuffix.type && EXCLUSIVE_INSCRIPTION_TYPES.includes(updatedPrefix.type)) {
    res.status(400).json({ error: `Cannot have both ${updatedPrefix.type} prefix and suffix on the same item` });
    return;
  }

  // A listed item sits in an OrdLock; the batch can't be spending what the listing holds.
  if (await anyTokenListed(marketplaceItemsCollection, itemIds, 'inventoryItemId')) {
    res.status(409).json({ error: ITEM_LISTED });
    return;
  }

  // Pre-lock read: this only needs a wallet handle for getPublicKey/unlock-template
  // estimation (no UTXO ops), so it's safe outside the serialized queue. Same
  // singleton wallet the queue itself uses.
  const serverWallet = await getServerWallet();
  const ordinalP2PKH = new OrdinalsP2PKH();

  // Parse payment and batch transfer transactions
  const paymentBeef = decodeBeef(paymentTx);
  const paymentTransaction = Transaction.fromBEEF(paymentBeef);
  const paymentTxId = paymentTransaction.id('hex');

  const paymentOutput = paymentTransaction.outputs[0];
  if (!paymentOutput || !paymentOutput.satoshis || paymentOutput.satoshis < 100) {
    res.status(400).json({ error: 'Invalid payment: must be at least 100 satoshis' });
    return;
  }

  const paymentOutpoint = `${paymentTxId}.0`;

  // Decode batch transfer BEEF (no overlay fetch)
  const batchTransferTransaction = Transaction.fromBEEF(decodeBeef(batchTransferBeef));

  // The batch must move exactly the owned equipment and scrolls, whole, to the server.
  const transferFailure = checkBatchTransfer(
    batchTransferTransaction,
    await serverLockPattern(serverWallet, transferNonce, userIdentityKey),
    [
      { label: `Equipment ${originalEquipment.lootTableId}`, doc: originalEquipment },
      ...scrolls.map((s) => ({ label: `Scroll ${s.doc.lootTableId}`, doc: s.doc })),
    ].map(({ label, doc }, i) => ({
      label,
      tokenId: transferOutpoints[i],
      ownedTokenId: doc.tokenId!,
      amount: 1,
      amountRule: 'must carry amount 1',
      lootTableId: doc.lootTableId,
      mintOutpoint: doc.mintOutpoint,
    })),
  );
  if (transferFailure) {
    res.status(transferFailure.status).json({ error: transferFailure.error });
    return;
  }
  step('validated + payment parsed');

  const walletp2pkh = new WalletP2PKH(serverWallet);
  const walletP2pkhUnlockTemplate = walletp2pkh.unlock({
    protocolID: walletParams.protocolID,
    keyID: walletParams.keyID,
    counterparty: walletParams.counterparty,
  });
  const walletP2pkhUnlockingLength = await walletP2pkhUnlockTemplate.estimateLength();

  // Metadata for the updated equipment — no wallet needed, built pre-lock so it's
  // available both inside the queue (locking script) and after it (DB write).
  const updatedEquipmentMetadata = {
    name: 'game_item',
    itemName: equipmentLoot.name,
    description: equipmentLoot.description,
    icon: equipmentLoot.icon,
    rarity: equipmentLoot.rarity,
    itemType: equipmentLoot.type,
    tier: originalEquipment.tier,
    stats: equipmentLoot.equipmentStats || {},
    crafted: originalEquipment.crafted ? { statRoll: originalEquipment.statRoll } : null,
    enhancements: { prefix: updatedPrefix, suffix: updatedSuffix },
    visual: { borderGradient: originalEquipment.borderGradient },
  };

  const assetId = mintAssetId(originalEquipment.mintOutpoint)!; // checked by checkBatchTransfer

  // Obtained before claiming so a queue failure can't strand the claim.
  const queue = await getWalletQueue();

  // A concurrent craft/update/listing can't spend the same items.
  const claimId = await claimTokens(
    userInventoryCollection,
    userId,
    [originalEquipment, ...scrolls.map((s) => s.doc)].map((doc) => ({ _id: doc._id, tokenId: doc.tokenId! })),
  );
  if (!claimId) {
    res.status(409).json({ error: TOKEN_CLAIM_FAILED });
    return;
  }

  // ALL wallet UTXO-touching work runs inside the serialized queue.
  const result = await queue.enqueue('update:equipment', async (serverWallet) => {
    // Single unlock template shared by all transferred ordinal inputs (they share N2)
    const unlockTemplate = ordinalP2PKH.unlock(
      serverWallet, 'all', false, undefined, undefined,
      transferNonce
        ? { protocolID: TOKEN_PROTOCOL, keyID: transferNonce, counterparty: userIdentityKey }
        : undefined, // legacy: fixed key
    );
    const unlockingScriptLength = await unlockTemplate.estimateLength();

    // Derive user recipient key for the updated equipment output
    const serverIdentityKey = await getServerIdentityPublicKey();
    const N3 = generateNonce();
    const userKey = await deriveRecipientKey(serverWallet, userIdentityKey, N3);

    const updatedEquipmentLockingScript = ordinalP2PKH.lock(
      userKey,
      assetId,
      updatedEquipmentMetadata,
      'transfer'
    );

    // Build inputs: equipment + scrolls (shared unlock template) + payment
    const inputs = transferOutpoints.map((outpoint, i) => ({
      inputDescription: i === 0 ? 'Transferred equipment token' : `Transferred scroll token ${i}`,
      outpoint,
      unlockingScriptLength,
    }));

    inputs.push({
      inputDescription: 'User WalletP2PKH payment for fees',
      outpoint: paymentOutpoint,
      unlockingScriptLength: walletP2pkhUnlockingLength,
    });

    const mergedBeef = new Beef();
    mergedBeef.mergeBeef(batchTransferTransaction.toBEEF());
    mergedBeef.mergeBeef(paymentTransaction.toBEEF());
    const inputBEEF = mergedBeef.toBinary();

    const updateActionRes = await serverWallet.createAction({
      description: `Updating equipment with ${scrolls.length} inscription scroll(s)`,
      inputBEEF,
      inputs,
      outputs: [{
        outputDescription: 'Updated equipment back to user',
        lockingScript: updatedEquipmentLockingScript.toHex(),
        satoshis: 1,
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });

    if (!updateActionRes.signableTransaction) {
      throw new Error('Failed to create signable update transaction');
    }
    step('createAction done');

    const reference = updateActionRes.signableTransaction.reference;
    const txToSign = Transaction.fromBEEF(updateActionRes.signableTransaction.tx);

    // Apply shared unlock template to all ordinal inputs (0..N-2); payment gets WalletP2PKH
    for (let i = 0; i < inputs.length - 1; i++) {
      txToSign.inputs[i].unlockingScriptTemplate = unlockTemplate;
      txToSign.inputs[i].sourceTransaction = batchTransferTransaction;
    }

    const paymentInputIndex = inputs.length - 1;
    txToSign.inputs[paymentInputIndex].unlockingScriptTemplate = walletP2pkhUnlockTemplate;
    txToSign.inputs[paymentInputIndex].sourceTransaction = paymentTransaction;

    await txToSign.sign();
    step('local sign done');

    const spends: Record<string, any> = {};
    for (let i = 0; i < inputs.length; i++) {
      const unlockingScript = txToSign.inputs[i].unlockingScript;
      if (!unlockingScript) throw new Error(`Missing unlocking script for input ${i}`);
      spends[String(i)] = { unlockingScript: unlockingScript.toHex() };
    }

    const updateAction = await serverWallet.signAction({ reference, spends });

    if (!updateAction.tx) throw new Error('Failed to sign update action');
    step('signAction done — token ready, overlay push fired off-path');

    // Derive the txid locally from the signed tx — this IS what broadcastTX would
    // report (it also just computes tx.id('hex')).
    const updateTx = Transaction.fromAtomicBEEF(updateAction.tx);
    const updateTxId = updateTx.id('hex');
    const updatedEquipmentTokenId = `${updateTxId}.0`;

    return {
      updateActionTx: updateAction.tx,
      updatedEquipmentTokenId,
      updateTxId,
      N3,
      serverIdentityKey,
    };
  }).catch(async (err) => {
    await releaseTokens(userInventoryCollection, claimId);
    throw err;
  });

  // DB writes are best-effort: the update is already on chain, so the client always
  // gets the BEEF. On failure the claim stays held, since the claimed outpoints are spent.
  let dbRecorded = false;
  let nftId: string | undefined;
  let newInventoryItemId: string | undefined;
  let wasEquipped = false;
  try {
    const mintOutpoint = originalEquipment.mintOutpoint; // the item's BSV-21 id carries over

    // Carries keyId/counterparty for wallet internalization (not on the NFTLoot type).
    const updatedNftLootDoc = {
      lootTableId: originalEquipment.lootTableId,
      name: equipmentLoot.name,
      description: equipmentLoot.description,
      icon: equipmentLoot.icon,
      rarity: equipmentLoot.rarity,
      type: equipmentLoot.type,
      attributes: { ...updatedEquipmentMetadata, borderGradient: originalEquipment.borderGradient },
      mintOutpoint,
      tokenId: result.updatedEquipmentTokenId,
      keyId: result.N3,
      counterparty: result.serverIdentityKey,
      userId,
      createdAt: new Date(),
    };
    const nftResult = await nftLootCollection.insertOne(updatedNftLootDoc);
    nftId = nftResult.insertedId.toString();

    const inventoryResult = await userInventoryCollection.insertOne({
      userId,
      lootTableId: originalEquipment.lootTableId,
      itemType: equipmentLoot.type,
      nftLootId: nftResult.insertedId,
      mintOutpoint,
      tokenId: result.updatedEquipmentTokenId,
      transactionId: result.updateTxId,
      keyId: result.N3,
      counterparty: result.serverIdentityKey,
      tier: originalEquipment.tier,
      borderGradient: originalEquipment.borderGradient,
      prefix: updatedPrefix ?? undefined,
      suffix: updatedSuffix ?? undefined,
      acquiredAt: new Date(),
      fromMonsterId: originalEquipment.fromMonsterId,
      fromSessionId: originalEquipment.fromSessionId,
      updatedFrom: originalEquipmentInventoryId,
      crafted: originalEquipment.crafted,
      statRoll: originalEquipment.statRoll,
      rolledStats: originalEquipment.rolledStats,
      isEmpowered: originalEquipment.isEmpowered,
      enhanced: originalEquipment.enhanced,
    } as UserInventory);
    newInventoryItemId = inventoryResult.insertedId.toString();

    // Auto-update equipped slot references if old item was equipped
    const playerStats = await playerStatsCollection.findOne({ userId });
    if (playerStats) {
      const updateFields: Record<string, ObjectId> = {};

      for (const slot of EQUIPMENT_SLOTS) {
        if (playerStats.equippedItems?.[slot]?.equals(originalEquipment._id)) {
          updateFields[`equippedItems.${slot}`] = inventoryResult.insertedId;
          wasEquipped = true;
        }
      }

      if (Object.keys(updateFields).length > 0) {
        await playerStatsCollection.updateOne({ userId }, { $set: updateFields });
      }
    }

    // Delete original equipment and consumed scrolls at the outpoints this request claimed.
    for (const doc of [originalEquipment, ...scrolls.map((s) => s.doc)]) {
      const { deletedCount } = await userInventoryCollection.deleteOne({ _id: doc._id, userId, tokenId: doc.tokenId, pendingClaim: claimId });
      if (deletedCount !== 1) console.error(`[equipment:update] consumed item ${doc.tokenId} not deleted (claim lost)`);
    }
    dbRecorded = true;
    step('db written');
  } catch (dbErr) {
    console.error(`[equipment:update] DB write failed after on-chain update ${result.updateTxId} (claim ${claimId} held):`, dbErr);
  }

  res.json({
    success: true,
    dbRecorded,
    nftId,
    tokenId: result.updatedEquipmentTokenId,
    transactionId: result.updateTxId,
    newInventoryItemId,
    wasEquipped,
    transferBeef: encodeBeef(Array.from(result.updateActionTx as Uint8Array)),
    received: {
      outputIndex: 0,
      keyId: result.N3,
      counterparty: result.serverIdentityKey,
      tags: ['type:equipment'],
    },
  });

  // Fire-and-forget overlay push, off the response path and outside the wallet
  // queue lock. The token is already on-chain (signAction); this only speeds up
  // overlay-based lookups.
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(result.updateActionTx)))
    .catch((e) => {
      console.error('[equipment:update] overlay broadcast failed (non-blocking):', e);
    });
});

// Fetches the currently equipped items for the authenticated user.
equipmentRouter.get('/get', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;

    // Connect to MongoDB
    const { playerStatsCollection, userInventoryCollection } = await connectToMongo();

    // Fetch player stats to get equipped item IDs
    const playerStats = await playerStatsCollection.findOne({ userId });

    if (!playerStats) {
      res.status(404).json({ error: 'Player stats not found' });
      return;
    }

    if (!playerStats.equippedItems) {
      res.json({});
      return;
    }

    // Collect all equipped item IDs
    const equippedItemIds = Object.values(playerStats.equippedItems).filter(Boolean);

    if (equippedItemIds.length === 0) {
      res.json({});
      return;
    }

    // Fetch all equipped items in a single query
    const items = await userInventoryCollection.find({
      _id: { $in: equippedItemIds },
      userId
    }).toArray();

    // Build response object with slot mapping
    const equippedItems: {
      equippedWeapon?: { inventoryId: string; lootTableId: string; tier: number; isEmpowered?: boolean; crafted?: boolean; statRoll?: number; prefix?: any; suffix?: any };
      equippedArmor?: { inventoryId: string; lootTableId: string; tier: number; isEmpowered?: boolean; crafted?: boolean; statRoll?: number; prefix?: any; suffix?: any };
      equippedAccessory1?: { inventoryId: string; lootTableId: string; tier: number; isEmpowered?: boolean; crafted?: boolean; statRoll?: number; prefix?: any; suffix?: any };
      equippedAccessory2?: { inventoryId: string; lootTableId: string; tier: number; isEmpowered?: boolean; crafted?: boolean; statRoll?: number; prefix?: any; suffix?: any };
    } = {};

    // Map items back to their slots
    items.forEach(item => {
      const itemData = {
        inventoryId: item._id.toString(),
        lootTableId: item.lootTableId,
        tier: item.tier || 1,
        isEmpowered: item.isEmpowered || false,
        crafted: item.crafted,
        statRoll: item.statRoll,
        prefix: item.prefix, // Phase 3.4: Prefix inscription
        suffix: item.suffix  // Phase 3.4: Suffix inscription
      };

      if (playerStats.equippedItems!.weapon?.equals(item._id)) {
        equippedItems.equippedWeapon = itemData;
      } else if (playerStats.equippedItems!.armor?.equals(item._id)) {
        equippedItems.equippedArmor = itemData;
      } else if (playerStats.equippedItems!.accessory1?.equals(item._id)) {
        equippedItems.equippedAccessory1 = itemData;
      } else if (playerStats.equippedItems!.accessory2?.equals(item._id)) {
        equippedItems.equippedAccessory2 = itemData;
      }
    });

    res.json(equippedItems);
  } catch (error) {
    console.error('Error fetching equipment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Validates if an item type can be equipped in a specific slot
 */
function validateItemForSlot(itemType: string, slot: string): boolean {
  switch (slot) {
    case 'weapon':
      return itemType === 'weapon';
    case 'armor':
      return itemType === 'armor';
    case 'accessory1':
    case 'accessory2':
      return itemType === 'artifact'; // Accessories are artifacts
    default:
      return false;
  }
}

// Equips an item from user's inventory to a specific slot. Body: { inventoryId, slot, proof }.
equipmentRouter.post('/equip', requireAuthProof('equip'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;
    const body = req.body;

    const { inventoryId, slot } = body;

    if (!inventoryId || !slot) {
      res.status(400).json({ error: 'Missing inventoryId or slot' });
      return;
    }

    // Validate slot
    const validSlots = ['weapon', 'armor', 'accessory1', 'accessory2'];
    if (!validSlots.includes(slot)) {
      res.status(400).json({ error: 'Invalid slot' });
      return;
    }

    // Connect to MongoDB
    const { playerStatsCollection, userInventoryCollection } = await connectToMongo();

    // Verify the item exists in user's inventory
    let itemObjectId: ObjectId;
    try {
      itemObjectId = new ObjectId(inventoryId);
    } catch {
      res.status(400).json({ error: 'Invalid inventoryId format' });
      return;
    }

    const inventoryItem = await userInventoryCollection.findOne({
      _id: itemObjectId,
      userId
    });

    if (!inventoryItem) {
      res.status(404).json({ error: 'Item not found in inventory' });
      return;
    }

    // Get the loot item data to validate it can be equipped in this slot
    const lootItem = getLootItemById(inventoryItem.lootTableId);
    if (!lootItem) {
      res.status(400).json({ error: 'Invalid item' });
      return;
    }

    // Validate the item can be equipped in the requested slot
    const canEquip = validateItemForSlot(lootItem.type, slot);
    if (!canEquip) {
      res.status(400).json({ error: `Cannot equip ${lootItem.type} in ${slot} slot` });
      return;
    }

    // Update player stats with the equipped item
    await playerStatsCollection.updateOne(
      { userId },
      { $set: { [`equippedItems.${slot}`]: itemObjectId } }
    );

    res.json({
      success: true,
      slot,
      inventoryId,
      lootTableId: inventoryItem.lootTableId
    });
  } catch (error) {
    console.error('Error equipping item:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unequips an item from a specific slot. Body: { slot, proof }.
equipmentRouter.post('/unequip', requireAuthProof('unequip'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;
    const body = req.body;

    const { slot } = body;

    if (!slot) {
      res.status(400).json({ error: 'Missing slot' });
      return;
    }

    // Validate slot
    const validSlots = ['weapon', 'armor', 'accessory1', 'accessory2'];
    if (!validSlots.includes(slot)) {
      res.status(400).json({ error: 'Invalid slot' });
      return;
    }

    // Connect to MongoDB
    const { playerStatsCollection } = await connectToMongo();

    // Unset the equipped item field
    await playerStatsCollection.updateOne(
      { userId },
      { $unset: { [`equippedItems.${slot}`]: '' } }
    );

    res.json({
      success: true,
      slot
    });
  } catch (error) {
    console.error('Error unequipping item:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

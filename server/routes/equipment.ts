// Server-side equipment update with inscription scrolls (batched derived-key pattern).
// Client transfers equipment + scrolls in one batch tx (posted BEEF + shared nonce N2).
// Server unlocks all transferred inputs with a single shared-derivation template,
// applies inscriptions, and outputs updated equipment to user's recipient-derived key (N3).
// Scrolls are consumed (no output). ALL wallet UTXO ops run through the serialized wallet
// queue (one action at a time) to prevent concurrent double-spends. Returns BEEF + N3 for
// the client to internalize.

import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
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
import { EQUIPMENT_SLOTS } from '@shared/types';

export const equipmentRouter = Router();

equipmentRouter.post('/update', requireAuthProof('update-equipment'), async (req: Request, res: Response) => {
  const userId = req.userId as string;

  // Per-step timing to localize update latency (cumulative ms from request start).
  const t0 = Date.now();
  const step = (label: string) => console.log(`[equipment:update] ${label} +${Date.now() - t0}ms`);

  const {
    originalEquipmentInventoryId,
    originalEquipmentTokenId,
    inscriptionScrollInventoryIds,   // Array of scroll inventory IDs
    transferredEquipmentTokenId,
    transferredScrollTokenIds,       // Array of transferred scroll outpoints
    batchTransferBeef,               // base64 BEEF of client's batch transfer tx
    transferNonce,                   // N2: shared nonce used to lock all transferred outputs to server; absent ⇒ legacy
    userIdentityKey,                 // Derivation counterparty (replaces userPublicKey)
    equipmentData,
    updatedPrefix,
    updatedSuffix,
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

  // Connect to MongoDB
  const { userInventoryCollection, nftLootCollection, playerStatsCollection } = await connectToMongo();

  // Verify equipment ownership
  const originalEquipment = await userInventoryCollection.findOne({
    _id: new ObjectId(originalEquipmentInventoryId),
    userId,
  });

  if (!originalEquipment) {
    res.status(404).json({ error: 'Original equipment not found or not owned by user' });
    return;
  }

  // Verify scroll ownership
  const scrollInventoryIds = inscriptionScrollInventoryIds.map((id: string) => new ObjectId(id));
  const inscriptionScrolls = await userInventoryCollection
    .find({ _id: { $in: scrollInventoryIds }, userId })
    .toArray();

  if (inscriptionScrolls.length !== inscriptionScrollInventoryIds.length) {
    res.status(404).json({ error: 'One or more inscription scrolls not found or not owned by user' });
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
  step('validated + payment parsed');

  const walletp2pkh = new WalletP2PKH(serverWallet);
  const walletP2pkhUnlockTemplate = walletp2pkh.unlock({
    protocolID: walletParams.protocolID,
    keyID: walletParams.keyID,
    counterparty: walletParams.counterparty,
  });
  const walletP2pkhUnlockingLength = await walletP2pkhUnlockTemplate.estimateLength();

  // Decode batch transfer BEEF (no overlay fetch)
  const batchTransferTransaction = Transaction.fromBEEF(decodeBeef(batchTransferBeef));

  // Metadata for the updated equipment — no wallet needed, built pre-lock so it's
  // available both inside the queue (locking script) and after it (DB write).
  const updatedEquipmentMetadata = {
    name: 'game_item',
    itemName: equipmentData.name,
    description: equipmentData.description,
    icon: equipmentData.icon,
    rarity: equipmentData.rarity,
    itemType: equipmentData.type,
    tier: equipmentData.tier,
    stats: equipmentData.equipmentStats,
    crafted: equipmentData.crafted || null,
    enhancements: { prefix: updatedPrefix, suffix: updatedSuffix },
    visual: { borderGradient: equipmentData.borderGradient },
  };

  const assetId = originalEquipmentTokenId.replace('.', '_');

  // ALL wallet UTXO-touching work runs inside the serialized queue.
  const result = await (await getWalletQueue()).enqueue('update:equipment', async (serverWallet) => {
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
    const inputs = [
      { inputDescription: 'Transferred equipment token', outpoint: transferredEquipmentTokenId, unlockingScriptLength },
    ];

    for (let i = 0; i < transferredScrollTokenIds.length; i++) {
      inputs.push({
        inputDescription: `Transferred scroll token ${i + 1}`,
        outpoint: transferredScrollTokenIds[i],
        unlockingScriptLength,
      });
    }

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
      description: `Updating equipment with ${inscriptionScrollInventoryIds.length} inscription scroll(s)`,
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
    // report (it also just computes tx.id('hex')), so no need to await the overlay
    // push here. The overlay push now happens off-path, after the response is sent.
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
  });

  // Update database (after the enqueue resolved — the update is already broadcast
  // on-chain by this point): preserve mint proof, add keyId/counterparty.
  const originalNFTLoot = await nftLootCollection.findOne({ _id: originalEquipment.nftLootId });

  const updatedEquipmentDoc = {
    lootTableId: equipmentData.lootTableId,
    name: equipmentData.name,
    description: equipmentData.description,
    icon: equipmentData.icon,
    rarity: equipmentData.rarity,
    type: equipmentData.type,
    attributes: { ...updatedEquipmentMetadata, borderGradient: equipmentData.borderGradient },
    mintOutpoint: originalNFTLoot?.mintOutpoint, // preserve original mint proof
    tokenId: result.updatedEquipmentTokenId,
    keyId: result.N3,
    counterparty: result.serverIdentityKey,
    userId,
    createdAt: new Date(),
  };

  const nftResult = await nftLootCollection.insertOne(updatedEquipmentDoc);
  const nftId = nftResult.insertedId.toString();

  const newInventoryEntry = {
    userId,
    lootTableId: equipmentData.lootTableId,
    itemType: equipmentData.type,
    nftLootId: nftResult.insertedId,
    mintOutpoint: originalNFTLoot?.mintOutpoint, // preserve original mint proof
    tokenId: result.updatedEquipmentTokenId,
    transactionId: result.updateTxId,
    keyId: result.N3,
    counterparty: result.serverIdentityKey,
    tier: equipmentData.tier || originalEquipment.tier,
    borderGradient: equipmentData.borderGradient || originalEquipment.borderGradient,
    prefix: updatedPrefix,
    suffix: updatedSuffix,
    acquiredAt: new Date(),
    fromMonsterId: originalEquipment.fromMonsterId,
    fromSessionId: originalEquipment.fromSessionId,
    updatedFrom: originalEquipmentInventoryId,
    crafted: originalEquipment.crafted,
    statRoll: originalEquipment.statRoll,
    isEmpowered: originalEquipment.isEmpowered,
    enhanced: originalEquipment.enhanced,
  };

  const inventoryResult = await userInventoryCollection.insertOne(newInventoryEntry);

  // Auto-update equipped slot references if old item was equipped
  const oldEquipmentId = new ObjectId(originalEquipmentInventoryId);
  const newEquipmentId = inventoryResult.insertedId;
  let wasEquipped = false;

  const playerStats = await playerStatsCollection.findOne({ userId });
  if (playerStats) {
    const updateFields: Record<string, ObjectId> = {};

    for (const slot of EQUIPMENT_SLOTS) {
      if (playerStats.equippedItems?.[slot]?.equals(oldEquipmentId)) {
        updateFields[`equippedItems.${slot}`] = newEquipmentId;
        wasEquipped = true;
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await playerStatsCollection.updateOne({ userId }, { $set: updateFields });
    }
  }

  // Delete original equipment and consumed scrolls (provenance is on-chain)
  await userInventoryCollection.deleteOne({ _id: oldEquipmentId });

  for (const scrollInventoryId of inscriptionScrollInventoryIds) {
    await userInventoryCollection.deleteOne({ _id: new ObjectId(scrollInventoryId), userId });
  }
  step('db written');

  res.json({
    success: true,
    nftId,
    tokenId: result.updatedEquipmentTokenId,
    transactionId: result.updateTxId,
    newInventoryItemId: inventoryResult.insertedId.toString(),
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

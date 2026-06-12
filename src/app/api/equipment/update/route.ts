// Server-side equipment update with inscription scrolls (batched derived-key pattern).
// Client transfers equipment + scrolls in one batch tx (posted BEEF + shared nonce N2).
// Server unlocks all transferred inputs with a single shared-derivation template,
// applies inscriptions, and outputs updated equipment to user's recipient-derived key (N3).
// Scrolls are consumed (no output). Returns BEEF + N3 for client to internalize.

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectToMongo } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { verifyJWT } from '@/utils/jwt';
import { Transaction, Beef } from '@bsv/sdk';
import { WalletP2PKH } from '@bsv/wallet-helper';
import { getServerWallet, getServerIdentityPublicKey } from '@/lib/serverWallet';
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';
import { broadcastTX } from '@/utils/overlayFunctions';
import { decodeBeef, encodeBeef } from '@/utils/beefEncoding';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey } from '@/utils/tokenDerivation';

export async function POST(request: NextRequest) {
  try {
    // 1. Verify JWT
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    const userId = payload.userId;

    // 2. Parse request body
    const body = await request.json();
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
    } = body;

    if (!originalEquipmentInventoryId || !inscriptionScrollInventoryIds || !transferredEquipmentTokenId || !transferredScrollTokenIds || !userIdentityKey || !batchTransferBeef) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!Array.isArray(inscriptionScrollInventoryIds) || inscriptionScrollInventoryIds.length === 0) {
      return NextResponse.json({ error: 'At least one inscription scroll required' }, { status: 400 });
    }

    if (inscriptionScrollInventoryIds.length > 2) {
      return NextResponse.json({ error: 'Maximum 2 inscription scrolls allowed (prefix + suffix)' }, { status: 400 });
    }

    if (!paymentTx) {
      return NextResponse.json({ error: 'Missing payment transaction' }, { status: 400 });
    }

    if (!walletParams || !walletParams.protocolID || !walletParams.keyID || !walletParams.counterparty) {
      return NextResponse.json({ error: 'Missing wallet derivation parameters' }, { status: 400 });
    }

    // 3. Connect to MongoDB
    const { userInventoryCollection, nftLootCollection, playerStatsCollection } = await connectToMongo();

    // 4. Verify equipment ownership
    const originalEquipment = await userInventoryCollection.findOne({
      _id: new ObjectId(originalEquipmentInventoryId),
      userId,
    });

    if (!originalEquipment) {
      return NextResponse.json({ error: 'Original equipment not found or not owned by user' }, { status: 404 });
    }

    // 5. Verify scroll ownership
    const scrollInventoryIds = inscriptionScrollInventoryIds.map(id => new ObjectId(id));
    const inscriptionScrolls = await userInventoryCollection
      .find({ _id: { $in: scrollInventoryIds }, userId })
      .toArray();

    if (inscriptionScrolls.length !== inscriptionScrollInventoryIds.length) {
      return NextResponse.json({ error: 'One or more inscription scrolls not found or not owned by user' }, { status: 404 });
    }

    // 6. Get server wallet
    const serverWallet = await getServerWallet();
    const ordinalP2PKH = new OrdinalsP2PKH();

    // 7. Parse payment and batch transfer transactions
    const paymentBeef = decodeBeef(paymentTx);
    const paymentTransaction = Transaction.fromBEEF(paymentBeef);
    const paymentTxId = paymentTransaction.id('hex');

    console.log('📥 [PAYMENT] Received WalletP2PKH payment transaction:', { txid: paymentTxId, walletParams });

    const paymentOutput = paymentTransaction.outputs[0];
    if (!paymentOutput || !paymentOutput.satoshis || paymentOutput.satoshis < 100) {
      return NextResponse.json({ error: 'Invalid payment: must be at least 100 satoshis' }, { status: 400 });
    }

    const paymentOutpoint = `${paymentTxId}.0`;

    const walletp2pkh = new WalletP2PKH(serverWallet);
    const walletP2pkhUnlockTemplate = walletp2pkh.unlock({
      protocolID: walletParams.protocolID,
      keyID: walletParams.keyID,
      counterparty: walletParams.counterparty,
    });
    const walletP2pkhUnlockingLength = await walletP2pkhUnlockTemplate.estimateLength();

    console.log('Server updating equipment (batched):', {
      equipmentName: equipmentData.name,
      scrollCount: inscriptionScrollInventoryIds.length,
      transferredEquipmentTokenId,
      transferredScrollTokenIds,
      userId,
      paymentAmount: paymentOutput.satoshis,
    });

    // Decode batch transfer BEEF (no overlay fetch)
    const batchTransferTransaction = Transaction.fromBEEF(decodeBeef(batchTransferBeef));

    console.log('✅ [VALIDATE] Batch transfer transaction decoded:', {
      outputs: batchTransferTransaction.outputs.length,
    });

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

    // Build updated equipment metadata and locking script
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

    console.log('🔀 [UPDATE] Creating update transaction:', {
      inputCount: inputs.length,
      equipment: transferredEquipmentTokenId,
      scrolls: transferredScrollTokenIds,
      payment: paymentOutpoint,
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

    const spends: Record<string, any> = {};
    for (let i = 0; i < inputs.length; i++) {
      const unlockingScript = txToSign.inputs[i].unlockingScript;
      if (!unlockingScript) throw new Error(`Missing unlocking script for input ${i}`);
      spends[String(i)] = { unlockingScript: unlockingScript.toHex() };
    }

    const updateAction = await serverWallet.signAction({ reference, spends });

    if (!updateAction.tx) throw new Error('Failed to sign update action');

    const updateTx = Transaction.fromAtomicBEEF(updateAction.tx);
    const updateBroadcast = await broadcastTX(updateTx);
    const updateTxId = updateBroadcast.txid!;
    const updatedEquipmentTokenId = `${updateTxId}.0`;

    console.log(`✅ [UPDATE] Updated equipment: ${updatedEquipmentTokenId}`);

    // Update database: preserve mint proof, add keyId/counterparty
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
      tokenId: updatedEquipmentTokenId,
      keyId: N3,
      counterparty: serverIdentityKey,
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
      tokenId: updatedEquipmentTokenId,
      transactionId: updateTxId,
      keyId: N3,
      counterparty: serverIdentityKey,
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
      const updateFields: any = {};

      if (playerStats.equippedWeapon?.equals(oldEquipmentId)) { updateFields.equippedWeapon = newEquipmentId; wasEquipped = true; }
      if (playerStats.equippedArmor?.equals(oldEquipmentId)) { updateFields.equippedArmor = newEquipmentId; wasEquipped = true; }
      if (playerStats.equippedAccessory1?.equals(oldEquipmentId)) { updateFields.equippedAccessory1 = newEquipmentId; wasEquipped = true; }
      if (playerStats.equippedAccessory2?.equals(oldEquipmentId)) { updateFields.equippedAccessory2 = newEquipmentId; wasEquipped = true; }

      if (Object.keys(updateFields).length > 0) {
        await playerStatsCollection.updateOne({ userId }, { $set: updateFields });
        console.log('✅ [EQUIPMENT] Auto-updated equipped item references:', updateFields);
      }
    }

    // Delete original equipment and consumed scrolls (provenance is on-chain)
    await userInventoryCollection.deleteOne({ _id: oldEquipmentId });

    for (const scrollInventoryId of inscriptionScrollInventoryIds) {
      await userInventoryCollection.deleteOne({ _id: new ObjectId(scrollInventoryId), userId });
    }

    console.log('✅ [DATABASE] Updated equipment documents:', {
      deletedScrolls: inscriptionScrollInventoryIds.length,
      newInventoryItemId: inventoryResult.insertedId.toString(),
    });

    return NextResponse.json({
      success: true,
      nftId,
      tokenId: updatedEquipmentTokenId,
      transactionId: updateTxId,
      newInventoryItemId: inventoryResult.insertedId.toString(),
      wasEquipped,
      transferBeef: encodeBeef(Array.from(updateAction.tx!)),
      received: {
        outputIndex: 0,
        keyId: N3,
        counterparty: serverIdentityKey,
        tags: ['type:equipment'],
      },
    });

  } catch (error) {
    console.error('Equipment update error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update equipment' },
      { status: 500 }
    );
  }
}

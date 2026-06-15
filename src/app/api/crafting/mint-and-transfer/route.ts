// Server-side crafting: derived-key transfer-to-server pattern (multi-input + multi-output).
// Client batches ALL materials into ONE transfer tx locked to a server recipient-derived key
// using a single shared nonce N2, then POSTs that tx's BEEF + N2.
// Server: validates transferred materials (shared N2), mints crafted item to a self-derived
// key (mintNonce), then in one transfer tx consumes [materials + crafted item] and outputs
// [crafted item → user (N3_item) + each material change → user (N3_change_i)].
// Returns BEEF + received[] for client to internalize all outputs.

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';
import { getServerWallet, getServerPublicKey, getServerIdentityPublicKey } from '@/lib/serverWallet';
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';
import { Transaction, P2PKH, Beef, Hash } from '@bsv/sdk';
import { WalletP2PKH } from '@bsv/wallet-helper';
import { broadcastTX } from '@/utils/overlayFunctions';
import { decodeBeef, encodeBeef } from '@/utils/beefEncoding';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey, deriveSelfKey } from '@/utils/tokenDerivation';

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
      recipeId,
      transferredMaterials,   // Array of {lootTableId, tokenId, quantity, quantityNeeded, itemName, description, icon, rarity, tier}
      outputItem,
      userIdentityKey,        // replaces userPublicKey; derivation counterparty
      paymentTx,              // base64 WalletP2PKH payment BEEF
      batchTransferBeef,      // base64 BEEF of client's single batch transfer (replaces per-material overlay fetch)
      transferNonce,          // N2: shared nonce client used to lock all materials to server
      walletParams,
    } = body;

    if (!transferredMaterials || !Array.isArray(transferredMaterials) || transferredMaterials.length === 0) {
      return NextResponse.json({ error: 'Missing or invalid transferredMaterials' }, { status: 400 });
    }

    if (!outputItem || !userIdentityKey) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!paymentTx) {
      return NextResponse.json({ error: 'Missing payment transaction' }, { status: 400 });
    }

    if (!batchTransferBeef) {
      return NextResponse.json({ error: 'Missing batch transfer BEEF' }, { status: 400 });
    }

    if (!walletParams || !walletParams.protocolID || !walletParams.keyID || !walletParams.counterparty) {
      return NextResponse.json({ error: 'Missing wallet derivation parameters' }, { status: 400 });
    }

    // 3. Connect to MongoDB
    const { userInventoryCollection, nftLootCollection, materialTokensCollection } = await connectToMongo();

    // 4. Get server wallet
    const serverWallet = await getServerWallet();
    const ordinalP2PKH = new OrdinalsP2PKH();

    // 5. Parse payment transaction
    const paymentBeef = decodeBeef(paymentTx);
    const paymentTransaction = Transaction.fromBEEF(paymentBeef);
    const paymentTxId = paymentTransaction.id('hex');

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

    console.log('Server crafting (derived-key):', {
      recipeId,
      materialCount: transferredMaterials.length,
      outputName: outputItem.name,
      userId,
      paymentAmount: paymentOutput.satoshis,
    });

    // 6. Parse batch transfer BEEF once — all material outputs live in this tx
    const batchTransferTransaction = Transaction.fromBEEF(decodeBeef(batchTransferBeef));

    // Derive the server key all materials were locked to (shared N2)
    const expectedServerKey = transferNonce
      ? (await serverWallet.getPublicKey({
          protocolID: TOKEN_PROTOCOL,
          keyID: transferNonce,
          counterparty: userIdentityKey,
          forSelf: true,
        })).publicKey
      : await getServerPublicKey(); // legacy fallback
    // OrdinalsP2PKH embeds hash160(pubkey), not raw pubkey hex
    const expectedScriptPattern = new P2PKH().lock(Hash.hash160(expectedServerKey, 'hex')).toHex();

    // 7. Validate each transferred material output
    for (const material of transferredMaterials) {
      const vout = parseInt(material.tokenId.split('.')[1]);
      const transferOutput = batchTransferTransaction.outputs[vout];

      if (!transferOutput) {
        return NextResponse.json({ error: `Transfer output not found: ${material.tokenId}` }, { status: 404 });
      }

      if (!transferOutput.lockingScript.toHex().includes(expectedScriptPattern)) {
        return NextResponse.json(
          { error: `Material ${material.lootTableId} not locked to server derived key` },
          { status: 400 }
        );
      }
    }

    console.log('✅ [VALIDATE] All transferred materials validated');

    // 8. Calculate material change amounts
    const materialChanges: Array<{
      lootTableId: string;
      itemName: string;
      description: string;
      icon: string;
      rarity: string;
      tier: number;
      changeAmount: number;
    }> = [];

    for (const material of transferredMaterials) {
      if (material.quantity > material.quantityNeeded) {
        materialChanges.push({
          lootTableId: material.lootTableId,
          itemName: material.itemName,
          description: material.description,
          icon: material.icon,
          rarity: material.rarity,
          tier: material.tier,
          changeAmount: material.quantity - material.quantityNeeded,
        });
      } else if (material.quantity < material.quantityNeeded) {
        return NextResponse.json(
          { error: `Insufficient ${material.lootTableId}: need ${material.quantityNeeded}, have ${material.quantity}` },
          { status: 400 }
        );
      }
    }

    // 9. Mint crafted item to a server self-derived key
    const craftedItemMetadata = {
      name: 'game_item',
      itemName: outputItem.name,
      description: outputItem.description,
      icon: outputItem.icon,
      rarity: outputItem.rarity,
      itemType: outputItem.type,
      tier: outputItem.tier || 1,
      stats: outputItem.equipmentStats || {},
      crafted: outputItem.crafted || null,
      enhancements: { prefix: null, suffix: null },
      visual: { borderGradient: outputItem.borderGradient },
      acquiredFrom: null,
      craftingProof: {
        recipeId,
        materialTokens: transferredMaterials.map(m => m.tokenId),
      },
    };

    const mintNonce = generateNonce();
    const craftedKey = await deriveSelfKey(serverWallet, mintNonce);
    const craftedItemLockingScript = ordinalP2PKH.lock(craftedKey, '', craftedItemMetadata, 'deploy+mint', 1);

    console.log('🔨 [MINT-CRAFT] Minting crafted item to self-derived key:', outputItem.name);

    const craftedItemMintActionRes = await serverWallet.createAction({
      description: 'Minting crafted item with user WalletP2PKH payment',
      inputBEEF: paymentBeef,
      inputs: [{
        inputDescription: 'User WalletP2PKH payment for fees',
        outpoint: paymentOutpoint,
        unlockingScriptLength: walletP2pkhUnlockingLength,
      }],
      outputs: [{
        outputDescription: 'Crafted item (self-derived key)',
        lockingScript: craftedItemLockingScript.toHex(),
        satoshis: 1,
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });

    if (!craftedItemMintActionRes.signableTransaction) {
      throw new Error('Failed to create signable crafted item mint transaction');
    }

    const craftedItemMintReference = craftedItemMintActionRes.signableTransaction.reference;
    const craftedItemTxToSign = Transaction.fromBEEF(craftedItemMintActionRes.signableTransaction.tx);

    craftedItemTxToSign.inputs[0].unlockingScriptTemplate = walletP2pkhUnlockTemplate;
    craftedItemTxToSign.inputs[0].sourceTransaction = paymentTransaction;
    await craftedItemTxToSign.sign();

    const craftedItemUnlockingScript = craftedItemTxToSign.inputs[0].unlockingScript;
    if (!craftedItemUnlockingScript) throw new Error('Missing unlocking script after signing crafted item');

    const craftedItemMintAction = await serverWallet.signAction({
      reference: craftedItemMintReference,
      spends: { '0': { unlockingScript: craftedItemUnlockingScript.toHex() } },
    });

    if (!craftedItemMintAction.tx) throw new Error('Failed to sign crafted item mint action');

    const craftedItemTx = Transaction.fromAtomicBEEF(craftedItemMintAction.tx);
    const craftedItemBroadcast = await broadcastTX(craftedItemTx);
    const craftedItemTxId = craftedItemBroadcast.txid!;
    const craftedItemOutpoint = `${craftedItemTxId}.0`;

    console.log(`✅ [MINT-CRAFT] Minted crafted item: ${craftedItemOutpoint}`);

    // 10. Transfer tx: [materials + crafted item] → [crafted item to user + change tokens to user]

    const serverIdentityKey = await getServerIdentityPublicKey();

    // Shared unlock template for all transferred materials (N2)
    const materialsUnlockTemplate = ordinalP2PKH.unlock(
      serverWallet, 'all', false, undefined, undefined,
      transferNonce
        ? { protocolID: TOKEN_PROTOCOL, keyID: transferNonce, counterparty: userIdentityKey }
        : undefined,
    );
    const materialsUnlockLength = await materialsUnlockTemplate.estimateLength();

    // Separate unlock template for crafted item (mintNonce, self)
    const craftedUnlockTemplate = ordinalP2PKH.unlock(
      serverWallet, 'all', false, undefined, undefined,
      { protocolID: TOKEN_PROTOCOL, keyID: mintNonce, counterparty: 'self' },
    );
    const craftedUnlockLength = await craftedUnlockTemplate.estimateLength();

    // Build inputs: all materials first, then crafted item
    const transferInputs: any[] = [];
    for (const material of transferredMaterials) {
      transferInputs.push({
        inputDescription: `Material: ${material.lootTableId}`,
        outpoint: material.tokenId,
        unlockingScriptLength: materialsUnlockLength,
      });
    }
    transferInputs.push({
      inputDescription: 'Crafted item',
      outpoint: craftedItemOutpoint,
      unlockingScriptLength: craftedUnlockLength,
    });

    // Build outputs: crafted item (index 0) then change tokens (indices 1, 2, ...)
    const transferOutputs: any[] = [];

    // Crafted item → user (unique nonce N3_item)
    const itemNonce = generateNonce();
    const itemKey = await deriveRecipientKey(serverWallet, userIdentityKey, itemNonce);
    const craftedAssetId = craftedItemOutpoint.replace('.', '_');
    transferOutputs.push({
      outputDescription: 'Crafted item to user',
      lockingScript: ordinalP2PKH.lock(itemKey, craftedAssetId, craftedItemMetadata, 'transfer', 1).toHex(),
      satoshis: 1,
    });

    // Change tokens → user (unique nonce per change)
    const changeNonces: string[] = [];
    for (const change of materialChanges) {
      const changeNonce = generateNonce();
      changeNonces.push(changeNonce);
      const changeKey = await deriveRecipientKey(serverWallet, userIdentityKey, changeNonce);
      const originalMaterial = transferredMaterials.find(m => m.lootTableId === change.lootTableId)!;
      const changeAssetId = originalMaterial.tokenId.replace('.', '_');
      transferOutputs.push({
        outputDescription: `Material change: ${change.lootTableId}`,
        lockingScript: ordinalP2PKH.lock(
          changeKey,
          changeAssetId,
          {
            name: 'material_token',
            lootTableId: change.lootTableId,
            itemName: change.itemName,
            description: change.description,
            icon: change.icon,
            rarity: change.rarity,
            tier: change.tier,
          },
          'transfer',
          change.changeAmount,
        ).toHex(),
        satoshis: 1,
      });
    }

    // Merge BEEFs for all inputs
    const mergedBeef = new Beef();
    mergedBeef.mergeBeef(batchTransferTransaction.toBEEF());
    mergedBeef.mergeBeef(craftedItemTx.toBEEF());
    const inputBEEF = mergedBeef.toBinary();

    const transferActionRes = await serverWallet.createAction({
      description: 'Transferring crafted item and material changes to user',
      inputBEEF,
      inputs: transferInputs,
      outputs: transferOutputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });

    if (!transferActionRes.signableTransaction) {
      throw new Error('Failed to create signable transfer transaction');
    }

    const reference = transferActionRes.signableTransaction.reference;
    const txToSign = Transaction.fromBEEF(transferActionRes.signableTransaction.tx);

    // Apply unlock templates: materials use shared template, crafted item uses its own
    const materialInputCount = transferredMaterials.length;
    if (!Number.isSafeInteger(materialInputCount) || materialInputCount < 0) {
      throw new Error('Invalid material input count');
    }
    if (materialInputCount >= txToSign.inputs.length) {
      throw new Error('Crafted input index out of range');
    }

    for (let i = 0; i < materialInputCount; i++) {
      txToSign.inputs[i].unlockingScriptTemplate = materialsUnlockTemplate;
      txToSign.inputs[i].sourceTransaction = batchTransferTransaction;
    }

    const craftedInputIndex = materialInputCount;
    txToSign.inputs[craftedInputIndex].unlockingScriptTemplate = craftedUnlockTemplate;
    txToSign.inputs[craftedInputIndex].sourceTransaction = craftedItemTx;

    await txToSign.sign();

    const spends: Record<string, any> = {};
    for (let i = 0; i < txToSign.inputs.length; i++) {
      const unlockingScript = txToSign.inputs[i].unlockingScript;
      if (!unlockingScript) throw new Error(`Missing unlocking script for input ${i}`);
      spends[String(i)] = { unlockingScript: unlockingScript.toHex() };
    }

    const transferAction = await serverWallet.signAction({ reference, spends });

    if (!transferAction.tx) throw new Error('Failed to sign transfer action');

    const transferTx = Transaction.fromAtomicBEEF(transferAction.tx);
    const transferBroadcast = await broadcastTX(transferTx);
    const transferTxId = transferBroadcast.txid!;

    console.log(`✅ [TRANSFER] Transferred crafted item + ${materialChanges.length} change tokens: ${transferTxId}`);

    // 11. Update database

    const userCraftedTokenId = `${transferTxId}.0`;

    // NFTLoot doc for crafted item (carries keyId/counterparty for wallet internalization)
    const nftLootDoc = {
      lootTableId: outputItem.lootTableId,
      name: outputItem.name,
      description: outputItem.description,
      icon: outputItem.icon,
      rarity: outputItem.rarity,
      type: outputItem.type,
      attributes: craftedItemMetadata,
      mintOutpoint: craftedItemOutpoint,
      tokenId: userCraftedTokenId,
      keyId: itemNonce,
      counterparty: serverIdentityKey,
      createdAt: new Date(),
    };

    const nftResult = await nftLootCollection.insertOne(nftLootDoc);
    const nftLootId = nftResult.insertedId.toString();

    // Calculate rolled stats for equipment
    let rolledStats: Record<string, number> | undefined;
    if (outputItem.crafted && outputItem.crafted.statRoll && outputItem.equipmentStats) {
      const statRoll = outputItem.crafted.statRoll;
      rolledStats = {};
      for (const [stat, value] of Object.entries(outputItem.equipmentStats)) {
        if (typeof value === 'number') {
          rolledStats[stat] = stat === 'autoClickRate'
            ? Math.round(value * statRoll * 100) / 100
            : Math.round(value * statRoll);
        }
      }
    }

    // UserInventory entry for crafted item
    const inventoryDoc: any = {
      userId,
      lootTableId: outputItem.lootTableId,
      itemType: outputItem.type,
      tier: outputItem.tier || 1,
      borderGradient: outputItem.borderGradient,
      nftLootId: nftResult.insertedId,
      mintOutpoint: craftedItemOutpoint,
      tokenId: userCraftedTokenId,
      keyId: itemNonce,
      counterparty: serverIdentityKey,
      acquiredAt: new Date(),
      crafted: true,
      statRoll: outputItem.crafted?.statRoll,
      rolledStats,
      updatedAt: new Date(),
    };

    await userInventoryCollection.insertOne(inventoryDoc);

    console.log(`✅ [DATABASE] Created crafted item in inventory (statRoll: ${outputItem.crafted?.statRoll})`);

    // Handle material token updates/deletions
    const lootTableIdsWithChange = new Set(materialChanges.map(c => c.lootTableId));

    // Delete fully consumed material tokens
    const fullyConsumedMaterials = transferredMaterials.filter(m => !lootTableIdsWithChange.has(m.lootTableId));
    for (const material of fullyConsumedMaterials) {
      await materialTokensCollection.deleteOne({ userId, lootTableId: material.lootTableId });
    }

    // Update change tokens with new outpoint + keyId/counterparty
    const materialChangeTokens: Array<{ lootTableId: string; tokenId: string; quantity: number }> = [];

    for (let i = 0; i < materialChanges.length; i++) {
      const change = materialChanges[i];
      const changeTokenId = `${transferTxId}.${i + 1}`;  // output 0 = crafted item
      const changeNonce = changeNonces[i];
      const originalMaterial = transferredMaterials.find(m => m.lootTableId === change.lootTableId)!;

      materialChangeTokens.push({ lootTableId: change.lootTableId, tokenId: changeTokenId, quantity: change.changeAmount });

      await materialTokensCollection.updateOne(
        { userId, lootTableId: change.lootTableId },
        {
          $set: {
            tokenId: changeTokenId,
            quantity: change.changeAmount,
            keyId: changeNonce,
            counterparty: serverIdentityKey,
            updatedAt: new Date(),
          },
          $push: {
            updateHistory: {
              operation: 'subtract',
              previousQuantity: originalMaterial.quantity,
              newQuantity: change.changeAmount,
              transactionId: transferTxId,
              reason: `Consumed in crafting recipe: ${recipeId}`,
              timestamp: new Date(),
            },
          },
        }
      );
    }

    console.log('✅ [DATABASE] Updated all database documents');

    // Build received[] aligned to transfer tx output indices
    const received: Array<{ outputIndex: number; keyId: string; counterparty: string; tags: string[] }> = [
      { outputIndex: 0, keyId: itemNonce, counterparty: serverIdentityKey, tags: ['type:item'] },
    ];
    for (let i = 0; i < materialChanges.length; i++) {
      received.push({
        outputIndex: i + 1,
        keyId: changeNonces[i],
        counterparty: serverIdentityKey,
        tags: ['type:material'],
      });
    }

    return NextResponse.json({
      success: true,
      nftId: nftLootId,
      tokenId: userCraftedTokenId,
      transferTransactionId: transferTxId,
      materialChangeTokens,
      transferBeef: encodeBeef(Array.from(transferAction.tx!)),
      received,
    });

  } catch (error) {
    console.error('Crafting mint and transfer error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to craft item' },
      { status: 500 }
    );
  }
}

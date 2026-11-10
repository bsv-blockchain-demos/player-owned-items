// Server-side crafting: derived-key transfer-to-server pattern (multi-input + multi-output).
// Client batches ALL materials into ONE transfer tx locked to a server recipient-derived key
// using a single shared nonce N2, then POSTs that tx's BEEF + N2.
// Server: validates transferred materials (shared N2), mints crafted item to a self-derived
// key (mintNonce), then in one transfer tx consumes [materials + crafted item] and outputs
// [crafted item → user (N3_item) + each material change → user (N3_change_i)].
// The mint + transfer are one dependent sequence and run as a single unit through the
// serialized wallet queue to prevent concurrent UTXO double-spends.
// Returns BEEF + received[] for client to internalize all outputs.

import { Router, type Request, type Response } from 'express';
import { ObjectId, type WithId } from 'mongodb';
import { EQUIPMENT_SLOTS, type MaterialToken, type UserInventory } from '@shared/types';
import { Transaction, P2PKH, Beef, Hash } from '@bsv/sdk';
import { WalletP2PKH } from '@bsv/wallet-helper';
import { requireAuthProof } from '@server/middleware/requireAuthProof';
import { getWalletQueue } from '@server/lib/walletQueue';
import { connectToMongo, getClient } from '@server/lib/mongodb';
import { getServerWallet, getServerPublicKey, getServerIdentityPublicKey } from '@server/lib/serverWallet';
import { OrdinalsP2PKH } from '@shared/ordinalP2PKH';
import { broadcastTX } from '@shared/overlayFunctions';
import { decodeBeef, encodeBeef } from '@shared/beefEncoding';
import { TOKEN_PROTOCOL, generateNonce, deriveRecipientKey, deriveSelfKey } from '@shared/tokenDerivation';
import { getLootItemById } from '@shared/loot-table';
import { getRecipeById } from '@shared/recipe-table';
import { publicKeyToGradient } from '@shared/publicKeyToColor';
import {
  claimTokens,
  releaseTokens,
  TOKEN_CLAIM_FAILED,
  anyTokenListed,
  TOKEN_LISTED,
  ITEM_LISTED,
  voutOf,
  transferAmount,
} from '@server/lib/materialUnits';

export const craftingRouter = Router();

craftingRouter.post('/mint-and-transfer', requireAuthProof('craft'), async (req: Request, res: Response) => {
  const userId = req.userId as string;

  // Per-step timing to localize craft latency (cumulative ms from request start).
  const t0 = Date.now();
  const step = (label: string) => console.log(`[crafting:mint] ${label} +${Date.now() - t0}ms`);

  const {
    recipeId,
    transferredMaterials, // Array of {lootTableId, tokenId, materialTokenId}: batch-tx outpoint + MaterialToken _id
    transferredItems = [], // Array of {lootTableId, tokenId, inventoryItemId}: batch-tx outpoint + minted UserInventory _id
    userIdentityKey, // derivation counterparty
    paymentTx, // base64 WalletP2PKH payment BEEF
    batchTransferBeef, // base64 BEEF of client's single batch transfer (all materials, shared N2)
    transferNonce, // N2: shared nonce client used to lock all materials to server
    walletParams,
  } = req.body;

  if (
    !Array.isArray(transferredMaterials) ||
    !Array.isArray(transferredItems) ||
    transferredMaterials.length + transferredItems.length === 0
  ) {
    res.status(400).json({ error: 'Missing or invalid transferredMaterials' });
    return;
  }

  if (!userIdentityKey) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  if (!paymentTx) {
    res.status(400).json({ error: 'Missing payment transaction' });
    return;
  }

  if (!batchTransferBeef) {
    res.status(400).json({ error: 'Missing batch transfer BEEF' });
    return;
  }

  if (!walletParams || !walletParams.protocolID || !walletParams.keyID || !walletParams.counterparty) {
    res.status(400).json({ error: 'Missing wallet derivation parameters' });
    return;
  }

  // Everything minted is derived from the recipe + loot table; the client only names the recipe.
  const recipe = getRecipeById(recipeId);
  if (!recipe) {
    res.status(400).json({ error: `Unknown recipe: ${recipeId}` });
    return;
  }

  // Each entry is one owned token; several tokens (e.g. different tiers) may cover one requirement.
  const entries = transferredMaterials as Array<{ lootTableId: unknown; tokenId: unknown; materialTokenId: unknown }>;
  const wellFormed = entries.every(
    (m) =>
      typeof m?.lootTableId === 'string' &&
      typeof m.tokenId === 'string' &&
      typeof m.materialTokenId === 'string' &&
      m.materialTokenId.length === 24 &&
      ObjectId.isValid(m.materialTokenId),
  );
  if (
    !wellFormed ||
    new Set(entries.map((m) => (m.materialTokenId as string).toLowerCase())).size !== entries.length ||
    new Set(entries.map((m) => m.tokenId)).size !== entries.length
  ) {
    res.status(400).json({ error: 'Invalid transferredMaterials' });
    return;
  }
  const transfers = entries as Array<{ lootTableId: string; tokenId: string; materialTokenId: string }>;

  // Non-material requirements (artifacts) are minted item NFTs, one per unit.
  const itemEntries = transferredItems as Array<{ lootTableId: unknown; tokenId: unknown; inventoryItemId: unknown }>;
  const batchOutpoints = [...entries, ...itemEntries].map((m) => m?.tokenId);
  if (
    !itemEntries.every(
      (m) =>
        typeof m?.lootTableId === 'string' &&
        typeof m.tokenId === 'string' &&
        typeof m.inventoryItemId === 'string' &&
        m.inventoryItemId.length === 24 &&
        ObjectId.isValid(m.inventoryItemId),
    ) ||
    new Set(itemEntries.map((m) => (m.inventoryItemId as string).toLowerCase())).size !== itemEntries.length ||
    new Set(batchOutpoints).size !== batchOutpoints.length
  ) {
    res.status(400).json({ error: 'Invalid transferredItems' });
    return;
  }
  const itemTransfers = itemEntries as Array<{ lootTableId: string; tokenId: string; inventoryItemId: string }>;

  const isMaterialRequirement = (lootTableId: string) => getLootItemById(lootTableId)?.type === 'material';
  const requiredQuantities = new Map(
    recipe.requiredMaterials.filter((r) => isMaterialRequirement(r.lootTableId)).map((r) => [r.lootTableId, r.quantity]),
  );
  const requiredItems = recipe.requiredMaterials.filter((r) => !isMaterialRequirement(r.lootTableId));
  const transferredLootIds = new Set(transfers.map((m) => m.lootTableId));
  const itemCount = (lootTableId: string) => itemTransfers.filter((t) => t.lootTableId === lootTableId).length;
  if (
    transferredLootIds.size !== requiredQuantities.size ||
    ![...transferredLootIds].every((id) => requiredQuantities.has(id)) ||
    itemTransfers.length !== requiredItems.reduce((sum, r) => sum + r.quantity, 0) ||
    !requiredItems.every((r) => itemCount(r.lootTableId) === r.quantity)
  ) {
    res.status(400).json({ error: `Transferred materials do not match recipe ${recipe.recipeId}` });
    return;
  }

  const outputLoot = getLootItemById(recipe.output.lootTableId);
  if (!outputLoot) throw new Error(`Recipe ${recipe.recipeId} output ${recipe.output.lootTableId} not in loot table`);

  // Connect to MongoDB
  const { userInventoryCollection, nftLootCollection, materialTokensCollection, playerStatsCollection, marketplaceItemsCollection } =
    await connectToMongo();

  const playerStats = await playerStatsCollection.findOne({ userId });
  if (recipe.unlocksAtLevel && (playerStats?.level ?? 1) < recipe.unlocksAtLevel) {
    res.status(403).json({ error: `Recipe ${recipe.recipeId} requires level ${recipe.unlocksAtLevel}` });
    return;
  }

  // Quantities and metadata come from the user's DB tokens + loot table, never the body.
  const ownedTokens: WithId<MaterialToken>[] = [];
  for (const transfer of transfers) {
    const owned = await materialTokensCollection.findOne({
      _id: new ObjectId(transfer.materialTokenId),
      userId,
      lootTableId: transfer.lootTableId,
      consumed: { $ne: true },
    });
    if (!owned) {
      res.status(400).json({ error: `Material ${transfer.lootTableId} not owned` });
      return;
    }
    ownedTokens.push(owned);
  }

  const equipped = new Set(Object.values(playerStats?.equippedItems ?? {}).filter(Boolean).map(String));
  const ownedItems: WithId<UserInventory>[] = [];
  for (const transfer of itemTransfers) {
    const owned = await userInventoryCollection.findOne({
      _id: new ObjectId(transfer.inventoryItemId),
      userId,
      lootTableId: transfer.lootTableId,
      nftLootId: { $type: 'objectId' },
      tokenId: { $type: 'string' },
    });
    if (!owned) {
      res.status(400).json({ error: `Item ${transfer.lootTableId} not owned` });
      return;
    }
    if (equipped.has(owned._id.toHexString())) {
      res.status(409).json({ error: `Item ${transfer.lootTableId} is equipped` });
      return;
    }
    ownedItems.push(owned);
  }
  const items = itemTransfers.map((transfer, i) => ({
    lootTableId: transfer.lootTableId,
    tokenId: transfer.tokenId, // outpoint in the batch transfer tx
    docId: ownedItems[i]._id,
    ownedTokenId: ownedItems[i].tokenId!, // outpoint the batch transfer must spend
  }));

  for (const [lootTableId, needed] of requiredQuantities) {
    const have = ownedTokens.filter((t) => t.lootTableId === lootTableId).reduce((sum, t) => sum + t.quantity, 0);
    if (have < needed) {
      res.status(400).json({ error: `Insufficient ${lootTableId}: need ${needed}, have ${have}` });
      return;
    }
  }

  // Consume tokens in the order sent; whatever a token has left is returned as change.
  const stillNeeded = new Map(requiredQuantities);
  const materials = transfers.map((transfer, i) => {
    const owned = ownedTokens[i];
    const used = Math.min(owned.quantity, stillNeeded.get(transfer.lootTableId)!);
    stillNeeded.set(transfer.lootTableId, stillNeeded.get(transfer.lootTableId)! - used);
    const loot = getLootItemById(transfer.lootTableId);
    return {
      lootTableId: transfer.lootTableId,
      tokenId: transfer.tokenId, // outpoint in the batch transfer tx
      docId: owned._id,
      ownedTokenId: owned.tokenId, // outpoint the batch transfer must spend
      quantity: owned.quantity,
      changeAmount: owned.quantity - used,
      itemName: loot?.name ?? transfer.lootTableId,
      description: loot?.description ?? '',
      icon: loot?.icon ?? '',
      rarity: loot?.rarity ?? 'common',
      tier: owned.tier ?? 1,
    };
  });

  // Pre-lock read: this only needs a wallet handle for getPublicKey/unlock-template
  // estimation (no UTXO ops), so it's safe outside the serialized queue. Same
  // singleton wallet the queue itself uses.
  const serverWallet = await getServerWallet();
  const ordinalP2PKH = new OrdinalsP2PKH();

  // Parse payment transaction
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

  // Parse batch transfer BEEF once — all material outputs live in this tx
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

  const spentOutpoints = new Set(
    batchTransferTransaction.inputs.map(
      (i) => `${i.sourceTXID || i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`,
    ),
  );

  // Validate each transferred output: materials, then items
  const batchTxId = batchTransferTransaction.id('hex');
  const transferredOutputs = [
    ...materials.map((m) => ({
      label: `Material ${m.lootTableId}`,
      tokenId: m.tokenId,
      ownedTokenId: m.ownedTokenId,
      amount: m.quantity,
      amountRule: `must carry the full token quantity (${m.quantity})`,
    })),
    ...items.map((t) => ({
      label: `Item ${t.lootTableId}`,
      tokenId: t.tokenId,
      ownedTokenId: t.ownedTokenId,
      amount: 1,
      amountRule: 'must carry amount 1',
    })),
  ];
  for (const output of transferredOutputs) {
    const vout = voutOf(output.tokenId, batchTxId);
    if (vout === null) {
      res.status(400).json({ error: `Transfer outpoint not in batch transfer: ${output.tokenId}` });
      return;
    }
    const transferOutput = batchTransferTransaction.outputs[vout];

    if (!transferOutput) {
      res.status(404).json({ error: `Transfer output not found: ${output.tokenId}` });
      return;
    }

    if (!transferOutput.lockingScript.toHex().includes(expectedScriptPattern)) {
      res.status(400).json({ error: `${output.label} not locked to server derived key` });
      return;
    }

    if (!spentOutpoints.has(output.ownedTokenId)) {
      res.status(400).json({ error: `${output.label} transfer does not spend owned token` });
      return;
    }

    // A partial amount would leave the rest of the token untracked on chain.
    if (transferAmount(transferOutput.lockingScript) !== output.amount) {
      res.status(400).json({ error: `${output.label} transfer ${output.amountRule}` });
      return;
    }
  }

  const materialChanges = materials.filter((m) => m.changeAmount > 0);

  const outputTier = recipe.output.tier || 1;
  const baseStats = outputLoot.equipmentStats as Record<string, number> | undefined;
  const statRoll = baseStats ? 0.8 + Math.random() * 0.4 : undefined;
  const borderGradient = publicKeyToGradient(userId);

  // Metadata for the crafted item — no wallet needed, built pre-lock so it's
  // available both inside the queue (locking script) and after it (DB write).
  const craftedItemMetadata = {
    name: 'game_item',
    itemName: outputLoot.name,
    description: outputLoot.description,
    icon: outputLoot.icon,
    rarity: outputLoot.rarity,
    itemType: outputLoot.type,
    tier: outputTier,
    stats: baseStats || {},
    crafted: statRoll !== undefined ? { statRoll, craftedBy: userId } : null,
    enhancements: { prefix: null, suffix: null },
    visual: { borderGradient },
    acquiredFrom: null,
    craftingProof: {
      recipeId: recipe.recipeId,
      materialTokens: materials.map((m) => m.tokenId),
      itemTokens: items.map((t) => t.tokenId),
    },
  };

  // A listing's OrdLock can be cancel-spent into the batch, leaving the listing live.
  if (await anyTokenListed(marketplaceItemsCollection, materials.map((m) => m.docId))) {
    res.status(409).json({ error: TOKEN_LISTED });
    return;
  }
  if (items.length && (await anyTokenListed(marketplaceItemsCollection, items.map((t) => t.docId), 'inventoryItemId'))) {
    res.status(409).json({ error: ITEM_LISTED });
    return;
  }

  // Obtained before claiming so a queue failure can't strand the claim.
  const queue = await getWalletQueue();

  // A concurrent craft/merge (e.g. a replayed batch transfer) can't spend the same tokens.
  const tokenClaimId = await claimTokens(
    materialTokensCollection,
    userId,
    materials.map((m) => ({ _id: m.docId, tokenId: m.ownedTokenId })),
  );
  if (!tokenClaimId) {
    res.status(409).json({ error: TOKEN_CLAIM_FAILED });
    return;
  }
  const itemClaimId = await claimTokens(
    userInventoryCollection,
    userId,
    items.map((t) => ({ _id: t.docId, tokenId: t.ownedTokenId })),
  );
  if (!itemClaimId) {
    await releaseTokens(materialTokensCollection, tokenClaimId);
    res.status(409).json({ error: TOKEN_CLAIM_FAILED });
    return;
  }

  // Both dependent wallet actions (mint the crafted item, then transfer it +
  // material change to the user) run as ONE serialized unit through the wallet queue.
  const result = await queue.enqueue('craft', async (serverWallet) => {
    // Mint crafted item to a server self-derived key.

    const mintNonce = generateNonce();
    const craftedKey = await deriveSelfKey(serverWallet, mintNonce);
    const craftedItemLockingScript = ordinalP2PKH.lock(craftedKey, '', craftedItemMetadata, 'deploy+mint', 1);

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
    step('createAction done (mint)');

    const craftedItemMintReference = craftedItemMintActionRes.signableTransaction.reference;
    const craftedItemTxToSign = Transaction.fromBEEF(craftedItemMintActionRes.signableTransaction.tx);

    craftedItemTxToSign.inputs[0].unlockingScriptTemplate = walletP2pkhUnlockTemplate;
    craftedItemTxToSign.inputs[0].sourceTransaction = paymentTransaction;
    await craftedItemTxToSign.sign();
    step('local sign done (mint)');

    const craftedItemUnlockingScript = craftedItemTxToSign.inputs[0].unlockingScript;
    if (!craftedItemUnlockingScript) throw new Error('Missing unlocking script after signing crafted item');

    const craftedItemMintAction = await serverWallet.signAction({
      reference: craftedItemMintReference,
      spends: { '0': { unlockingScript: craftedItemUnlockingScript.toHex() } },
    });

    if (!craftedItemMintAction.tx) throw new Error('Failed to sign crafted item mint action');
    step('signAction done (mint) — token ready, overlay push fired off-path');

    // Derive the txid locally from the signed tx — this IS what broadcastTX would
    // report (it also just computes tx.id('hex')). The overlay push for this
    // intermediate tx now happens off-path, after the response is sent.
    const craftedItemTx = Transaction.fromAtomicBEEF(craftedItemMintAction.tx);
    const craftedItemTxId = craftedItemTx.id('hex');
    const craftedItemOutpoint = `${craftedItemTxId}.0`;

    // Transfer tx: [materials + crafted item] → [crafted item to user + change tokens to user]

    const serverIdentityKey = await getServerIdentityPublicKey();

    // Shared unlock template for all transferred materials and items (N2)
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

    // Build inputs: all materials, then items, then crafted item
    const transferInputs: any[] = [];
    for (const input of [...materials.map((m) => ({ kind: 'Material', ...m })), ...items.map((t) => ({ kind: 'Item', ...t }))]) {
      transferInputs.push({
        inputDescription: `${input.kind}: ${input.lootTableId}`,
        outpoint: input.tokenId,
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
      const changeAssetId = change.tokenId.replace('.', '_');
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
    step('createAction done (transfer)');

    const reference = transferActionRes.signableTransaction.reference;
    const txToSign = Transaction.fromBEEF(transferActionRes.signableTransaction.tx);

    // Apply unlock templates: materials + items use the shared template, crafted item uses its own
    const materialInputCount = materials.length + items.length;
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
    step('local sign done (transfer)');

    const spends: Record<string, any> = {};
    for (let i = 0; i < txToSign.inputs.length; i++) {
      const unlockingScript = txToSign.inputs[i].unlockingScript;
      if (!unlockingScript) throw new Error(`Missing unlocking script for input ${i}`);
      spends[String(i)] = { unlockingScript: unlockingScript.toHex() };
    }

    const transferAction = await serverWallet.signAction({ reference, spends });

    if (!transferAction.tx) throw new Error('Failed to sign transfer action');
    step('signAction done (transfer) — token ready, overlay pushes fired off-path');

    // Derive locally — same value broadcastTX would report.
    const transferTx = Transaction.fromAtomicBEEF(transferAction.tx);
    const transferTxId = transferTx.id('hex');

    return {
      craftedItemMintActionTx: craftedItemMintAction.tx, // intermediate mint tx — pushed off-path too (Change 1, two-action route)
      transferActionTx: transferAction.tx,
      transferTxId,
      craftedItemOutpoint,
      itemNonce,
      changeNonces,
      serverIdentityKey,
    };
  }).catch(async (err) => {
    await releaseTokens(materialTokensCollection, tokenClaimId);
    await releaseTokens(userInventoryCollection, itemClaimId);
    throw err;
  });

  // DB writes are best-effort: the mint + transfer are already on chain, so the
  // client always gets the BEEF. On failure the token claim stays held, since the
  // claimed outpoints are spent and must not be offered again.

  const userCraftedTokenId = `${result.transferTxId}.0`;

  // Calculate rolled stats for equipment
  let rolledStats: Record<string, number> | undefined;
  if (statRoll !== undefined && baseStats) {
    rolledStats = {};
    for (const [stat, value] of Object.entries(baseStats)) {
      if (typeof value === 'number') {
        rolledStats[stat] = stat === 'autoClickRate'
          ? Math.round(value * statRoll * 100) / 100
          : Math.round(value * statRoll);
      }
    }
  }

  const materialChangeTokens = materialChanges.map((change, i) => ({
    lootTableId: change.lootTableId,
    tokenId: `${result.transferTxId}.${i + 1}`, // output 0 = crafted item
    quantity: change.changeAmount,
  }));

  let dbRecorded = false;
  let nftLootId: string | undefined;
  try {
    // NFTLoot doc for crafted item (carries keyId/counterparty for wallet internalization)
    const nftLootDoc = {
      lootTableId: outputLoot.lootId,
      name: outputLoot.name,
      description: outputLoot.description,
      icon: outputLoot.icon,
      rarity: outputLoot.rarity,
      type: outputLoot.type,
      attributes: craftedItemMetadata,
      mintOutpoint: result.craftedItemOutpoint,
      tokenId: userCraftedTokenId,
      keyId: result.itemNonce,
      counterparty: result.serverIdentityKey,
      createdAt: new Date(),
    };

    const nftResult = await nftLootCollection.insertOne(nftLootDoc);
    nftLootId = nftResult.insertedId.toString();

    // UserInventory entry for crafted item
    const inventoryDoc: any = {
      userId,
      lootTableId: outputLoot.lootId,
      itemType: outputLoot.type,
      tier: outputTier,
      borderGradient,
      nftLootId: nftResult.insertedId,
      mintOutpoint: result.craftedItemOutpoint,
      tokenId: userCraftedTokenId,
      keyId: result.itemNonce,
      counterparty: result.serverIdentityKey,
      acquiredAt: new Date(),
      crafted: true,
      statRoll,
      rolledStats,
      updatedAt: new Date(),
    };

    await userInventoryCollection.insertOne(inventoryDoc);

    // Material token write-backs target the exact docs, at the outpoints, this request claimed.
    // A miss means the claim was lost; the chain is already updated, so log rather than fail.
    for (const material of materials.filter((m) => m.changeAmount === 0)) {
      const { deletedCount } = await materialTokensCollection.deleteOne({
        _id: material.docId,
        userId,
        tokenId: material.ownedTokenId,
        pendingClaim: tokenClaimId,
      });
      if (deletedCount !== 1) console.error(`[crafting:mint] consumed token ${material.ownedTokenId} not deleted (claim lost)`);
    }

    for (const item of items) {
      const { deletedCount } = await userInventoryCollection.deleteOne({
        _id: item.docId,
        userId,
        tokenId: item.ownedTokenId,
        pendingClaim: itemClaimId,
      });
      if (deletedCount !== 1) console.error(`[crafting:mint] consumed item ${item.ownedTokenId} not deleted (claim lost)`);
    }
    // An equip that raced this craft would leave a slot pointing at a deleted doc.
    if (items.length) {
      const consumedIds = items.map((item) => item.docId);
      for (const slot of EQUIPMENT_SLOTS) {
        await playerStatsCollection.updateOne(
          { userId, [`equippedItems.${slot}`]: { $in: consumedIds } },
          { $unset: { [`equippedItems.${slot}`]: '' } },
        );
      }
    }

    // Update change tokens with new outpoint + keyId/counterparty
    for (let i = 0; i < materialChanges.length; i++) {
      const change = materialChanges[i];
      const { modifiedCount } = await materialTokensCollection.updateOne(
        { _id: change.docId, userId, tokenId: change.ownedTokenId, pendingClaim: tokenClaimId },
        {
          $unset: { pendingClaim: '' },
          $set: {
            tokenId: materialChangeTokens[i].tokenId,
            quantity: change.changeAmount,
            previousTokenId: change.ownedTokenId,
            lastTransactionId: result.transferTxId,
            keyId: result.changeNonces[i],
            counterparty: result.serverIdentityKey,
            updatedAt: new Date(),
          },
          $push: {
            updateHistory: {
              operation: 'subtract',
              previousQuantity: change.quantity,
              newQuantity: change.changeAmount,
              transactionId: result.transferTxId,
              reason: `Consumed in crafting recipe: ${recipe.recipeId}`,
              timestamp: new Date(),
            },
          },
        },
      );
      if (modifiedCount !== 1) console.error(`[crafting:mint] change token ${change.ownedTokenId} not updated (claim lost)`);
    }
    dbRecorded = true;
    step('db written');
  } catch (dbErr) {
    console.error(`[crafting:mint] DB write failed after on-chain craft ${result.transferTxId} (claims ${tokenClaimId}, ${itemClaimId} held):`, dbErr);
  }

  // Build received[] aligned to transfer tx output indices
  const received: Array<{ outputIndex: number; keyId: string; counterparty: string; tags: string[] }> = [
    { outputIndex: 0, keyId: result.itemNonce, counterparty: result.serverIdentityKey, tags: ['type:item'] },
  ];
  for (let i = 0; i < materialChanges.length; i++) {
    received.push({
      outputIndex: i + 1,
      keyId: result.changeNonces[i],
      counterparty: result.serverIdentityKey,
      tags: ['type:material'],
    });
  }

  res.json({
    success: true,
    dbRecorded,
    nftId: nftLootId,
    tokenId: userCraftedTokenId,
    transferTransactionId: result.transferTxId,
    materialChangeTokens,
    statRoll,
    rolledStats,
    transferBeef: encodeBeef(Array.from(result.transferActionTx as Uint8Array)),
    received,
  });

  // Fire-and-forget overlay pushes for BOTH txs (intermediate crafted-item mint +
  // final transfer), off the response path and outside the wallet queue lock. Both
  // are already on-chain (signAction); this only speeds up overlay-based lookups.
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(result.craftedItemMintActionTx)))
    .catch((e) => {
      console.error('[crafting:mint] overlay broadcast (mint) failed (non-blocking):', e);
    });
  void Promise.resolve()
    .then(() => broadcastTX(Transaction.fromAtomicBEEF(result.transferActionTx)))
    .catch((e) => {
      console.error('[crafting:mint] overlay broadcast (transfer) failed (non-blocking):', e);
    });
});

// Rerolls stat quality on crafted equipment using a Refine Stone.
// 1. Validate both items exist and belong to user
// 2. Validate target is crafted equipment with statRoll
// 3. Validate refine stone is actually a refine_stone
// 4. Generate new stat roll (0.8-1.2)
// 5. Recalculate rolledStats
// 6. Delete refine stone
// 7. Update target item
// 8. Return new stats
craftingRouter.post('/refine', requireAuthProof('refine'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;

    const { targetItemId, refineStoneId } = req.body;

    if (!targetItemId || !refineStoneId) {
      res.status(400).json({ error: 'Target item ID and refine stone ID required' });
      return;
    }

    // Convert string IDs to ObjectIds
    let targetObjectId: ObjectId;
    let refineStoneObjectId: ObjectId;
    try {
      targetObjectId = new ObjectId(targetItemId);
      refineStoneObjectId = new ObjectId(refineStoneId);
    } catch (error) {
      res.status(400).json({ error: 'Invalid item IDs' });
      return;
    }

    const { userInventoryCollection } = await connectToMongo();

    // Start MongoDB transaction
    const client = await getClient();
    const session = client.startSession();

    try {
      let result;

      await session.withTransaction(async () => {
        // Fetch both items from inventory
        const [targetItem, refineStone] = await Promise.all([
          userInventoryCollection.findOne({ _id: targetObjectId, userId }, { session }),
          userInventoryCollection.findOne({ _id: refineStoneObjectId, userId }, { session }),
        ]);

        // Validate target item exists
        if (!targetItem) {
          throw new Error('Target item not found or does not belong to you');
        }

        // Validate refine stone exists
        if (!refineStone) {
          throw new Error('Refine stone not found or does not belong to you');
        }

        // Validate refine stone is actually a refine_stone
        if (refineStone.lootTableId !== 'refine_stone') {
          throw new Error('Selected item is not a Refine Stone');
        }

        // Validate target is crafted equipment
        if (!targetItem.crafted) {
          throw new Error('Target item is not crafted equipment');
        }

        if (targetItem.statRoll === undefined) {
          throw new Error('Target item does not have a stat roll to refine');
        }

        // Get loot item template for target
        const targetLootItem = getLootItemById(targetItem.lootTableId);
        if (!targetLootItem || !targetLootItem.equipmentStats) {
          throw new Error('Target item has no equipment stats');
        }

        // Generate new stat roll (0.8 to 1.2)
        const rolledStatRoll = 0.8 + Math.random() * 0.4;
        const oldStatRoll = targetItem.statRoll;

        // If new roll is higher, use it. Otherwise, add +0.01 to current roll
        // This ensures guaranteed progress even with bad luck
        let finalStatRoll: number;
        let wasUpgraded: boolean;

        if (rolledStatRoll > oldStatRoll) {
          // Good roll - use the new higher value
          finalStatRoll = Math.min(1.2, rolledStatRoll); // Cap at max 1.2
          wasUpgraded = true;
        } else {
          // Bad roll - add +0.01 instead
          finalStatRoll = Math.min(1.2, oldStatRoll + 0.01); // Cap at max 1.2
          wasUpgraded = finalStatRoll > oldStatRoll; // Only true if not already at cap
        }

        // Recalculate rolledStats with final stat roll
        const finalRolledStats = {
          damageBonus: targetLootItem.equipmentStats.damageBonus !== undefined
            ? Math.round(targetLootItem.equipmentStats.damageBonus * finalStatRoll)
            : undefined,
          critChance: targetLootItem.equipmentStats.critChance !== undefined
            ? Math.round(targetLootItem.equipmentStats.critChance * finalStatRoll)
            : undefined,
          defense: targetLootItem.equipmentStats.defense !== undefined
            ? Math.round(targetLootItem.equipmentStats.defense * finalStatRoll)
            : undefined,
          maxHpBonus: targetLootItem.equipmentStats.maxHpBonus !== undefined
            ? Math.round(targetLootItem.equipmentStats.maxHpBonus * finalStatRoll)
            : undefined,
          attackSpeed: targetLootItem.equipmentStats.attackSpeed !== undefined
            ? Math.round(targetLootItem.equipmentStats.attackSpeed * finalStatRoll)
            : undefined,
          coinBonus: targetLootItem.equipmentStats.coinBonus !== undefined
            ? Math.round(targetLootItem.equipmentStats.coinBonus * finalStatRoll)
            : undefined,
          healBonus: targetLootItem.equipmentStats.healBonus !== undefined
            ? Math.round(targetLootItem.equipmentStats.healBonus * finalStatRoll)
            : undefined,
          lifesteal: targetLootItem.equipmentStats.lifesteal !== undefined
            ? Math.round(targetLootItem.equipmentStats.lifesteal * finalStatRoll)
            : undefined,
          defensiveLifesteal: targetLootItem.equipmentStats.defensiveLifesteal !== undefined
            ? Math.round(targetLootItem.equipmentStats.defensiveLifesteal * finalStatRoll)
            : undefined,
          thorns: targetLootItem.equipmentStats.thorns !== undefined
            ? Math.round(targetLootItem.equipmentStats.thorns * finalStatRoll)
            : undefined,
          autoClickRate: targetLootItem.equipmentStats.autoClickRate !== undefined
            ? Math.round(targetLootItem.equipmentStats.autoClickRate * finalStatRoll * 100) / 100 // Preserve decimals
            : undefined,
          fireResistance: targetLootItem.equipmentStats.fireResistance !== undefined
            ? Math.round(targetLootItem.equipmentStats.fireResistance * finalStatRoll)
            : undefined,
          poisonResistance: targetLootItem.equipmentStats.poisonResistance !== undefined
            ? Math.round(targetLootItem.equipmentStats.poisonResistance * finalStatRoll)
            : undefined,
          bleedResistance: targetLootItem.equipmentStats.bleedResistance !== undefined
            ? Math.round(targetLootItem.equipmentStats.bleedResistance * finalStatRoll)
            : undefined,
        };

        // Delete refine stone from inventory
        await userInventoryCollection.deleteOne(
          { _id: refineStoneObjectId },
          { session },
        );

        // Update target item with final statRoll and rolledStats (only if upgraded)
        if (wasUpgraded) {
          await userInventoryCollection.updateOne(
            { _id: targetObjectId },
            {
              $set: {
                statRoll: finalStatRoll,
                rolledStats: finalRolledStats,
              },
            },
            { session },
          );
        }

        result = {
          success: true,
          targetItem: {
            _id: targetItemId,
            name: targetLootItem.name,
          },
          oldStatRoll: oldStatRoll,
          rolledStatRoll: rolledStatRoll,
          finalStatRoll: finalStatRoll,
          wasUpgraded: wasUpgraded,
          newRolledStats: wasUpgraded ? finalRolledStats : targetItem.rolledStats,
        };
      });

      res.json(result);
      return;
    } catch (error: any) {
      console.error('Error refining item:', error);
      res.status(500).json({ error: error.message || 'Failed to refine item' });
      return;
    } finally {
      await session.endSession();
    }
  } catch (error) {
    console.error('Error in refining route:', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
});

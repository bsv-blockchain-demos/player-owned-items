// Server-side material add-and-merge (derived-key pattern).
// Client transfers its token to the server (posted BEEF + nonce), then calls this route.
// Server unlocks the transferred token, mints the added quantity, merges both into one
// output locked to the user's recipient-derived key, and returns the BEEF + nonce.

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
      transferredTokenId,  // 'txid.vout' of the transferred (server-owned) output
      transferBeef,        // base64 BEEF of client's transfer tx (NEW — replaces overlay fetch)
      transferNonce,       // N2: nonce client used to lock to server; absent ⇒ legacy token
      userIdentityKey,     // replaces userPublicKey; derivation counterparty
      lootTableId,
      itemName,
      description,
      icon,
      rarity,
      tier = 1,
      addedQuantity,
      currentQuantity,
      paymentTx,           // base64 WalletP2PKH payment BEEF
      walletParams,
      reason,
      acquiredFrom,
      inventoryItemIds,    // unminted UserInventory items being merged in (to consume)
    } = body;

    // Validate required fields
    if (!transferredTokenId || !lootTableId || !itemName || !userIdentityKey || !transferBeef) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!paymentTx) {
      return NextResponse.json({ error: 'Missing payment transaction' }, { status: 400 });
    }

    if (!walletParams || !walletParams.protocolID || !walletParams.keyID || !walletParams.counterparty) {
      return NextResponse.json({ error: 'Missing wallet derivation parameters' }, { status: 400 });
    }

    if (addedQuantity <= 0 || !Number.isInteger(addedQuantity)) {
      return NextResponse.json({ error: `Invalid addedQuantity: ${addedQuantity}` }, { status: 400 });
    }

    if (currentQuantity <= 0 || !Number.isInteger(currentQuantity)) {
      return NextResponse.json({ error: `Invalid currentQuantity: ${currentQuantity}` }, { status: 400 });
    }

    // 3. Connect to MongoDB
    const { materialTokensCollection, userInventoryCollection } = await connectToMongo();

    // 4. Verify user owns the material token
    const existingToken = await materialTokensCollection.findOne({
      userId,
      lootTableId,
      tier,
      consumed: { $ne: true },
    });

    if (!existingToken) {
      return NextResponse.json(
        { error: 'Material token not found or already consumed' },
        { status: 404 }
      );
    }

    if (existingToken.quantity !== currentQuantity) {
      return NextResponse.json(
        { error: `Quantity mismatch: expected ${existingToken.quantity}, got ${currentQuantity}` },
        { status: 409 }
      );
    }

    // 5. Get server wallet
    const serverWallet = await getServerWallet();
    const ordinalP2PKH = new OrdinalsP2PKH();

    // 6. Decode and parse payment transaction
    const paymentBeef = decodeBeef(paymentTx);
    const paymentTransaction = Transaction.fromBEEF(paymentBeef);
    const paymentTxId = paymentTransaction.id('hex');

    console.log('📥 [PAYMENT] Received WalletP2PKH payment transaction:', {
      txid: paymentTxId,
      walletParams,
    });

    const paymentOutput = paymentTransaction.outputs[0];
    if (!paymentOutput || !paymentOutput.satoshis || paymentOutput.satoshis < 100) {
      return NextResponse.json(
        { error: 'Invalid payment: must be at least 100 satoshis' },
        { status: 400 }
      );
    }

    const paymentOutpoint = `${paymentTxId}.0`;

    const walletp2pkh = new WalletP2PKH(serverWallet);
    const walletP2pkhUnlockTemplate = walletp2pkh.unlock({
      protocolID: walletParams.protocolID,
      keyID: walletParams.keyID,
      counterparty: walletParams.counterparty,
    });
    const walletP2pkhUnlockingLength = await walletP2pkhUnlockTemplate.estimateLength();

    console.log('Server adding and merging materials:', {
      lootTableId, itemName, transferredTokenId, currentQuantity, addedQuantity, userId,
    });

    // Validate the transferred token from the posted BEEF (no overlay).

    const transferTransaction = Transaction.fromBEEF(decodeBeef(transferBeef));

    const transferOutputIndex = parseInt(transferredTokenId.split('.')[1]);
    const transferOutput = transferTransaction.outputs[transferOutputIndex];

    if (!transferOutput) {
      return NextResponse.json({ error: 'Transfer output not found' }, { status: 404 });
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

    console.log('🔍 [VALIDATE] Validating transferred token:', {
      transferredTokenId,
      containsExpectedP2PKH: transferScriptHex.includes(expectedScriptPattern),
    });

    if (!transferScriptHex.includes(expectedScriptPattern)) {
      return NextResponse.json(
        { error: 'Transfer output not locked to server public key' },
        { status: 400 }
      );
    }

    console.log('✅ [VALIDATE] Transferred token validated');

    // Mint the added quantity to a self-derived key.

    const materialMetadata = {
      name: 'material_token',
      lootTableId,
      itemName,
      description,
      icon,
      rarity,
      tier,
      acquiredFrom: acquiredFrom ? [acquiredFrom] : [],
    };

    const mintNonce = generateNonce();
    const mintKey = await deriveSelfKey(serverWallet, mintNonce);
    const mintLockingScript = ordinalP2PKH.lock(mintKey, '', materialMetadata, 'deploy+mint', addedQuantity);

    console.log('🔨 [MINT] Minting new material token:', { lootTableId, addedQuantity });

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

    const mintReference = mintActionRes.signableTransaction.reference;
    const mintTxToSign = Transaction.fromBEEF(mintActionRes.signableTransaction.tx);

    mintTxToSign.inputs[0].unlockingScriptTemplate = walletP2pkhUnlockTemplate;
    mintTxToSign.inputs[0].sourceTransaction = paymentTransaction;
    await mintTxToSign.sign();

    const mintUnlockingScript = mintTxToSign.inputs[0].unlockingScript;
    if (!mintUnlockingScript) throw new Error('Missing unlocking script after signing');

    const mintAction = await serverWallet.signAction({
      reference: mintReference,
      spends: { '0': { unlockingScript: mintUnlockingScript.toHex() } },
    });

    if (!mintAction.tx) throw new Error('Failed to sign mint action');

    const mintTx = Transaction.fromAtomicBEEF(mintAction.tx);
    const mintBroadcast = await broadcastTX(mintTx);
    const mintTxId = mintBroadcast.txid!;
    const mintOutpoint = `${mintTxId}.0`;

    console.log(`✅ [MINT] Minted ${addedQuantity}x ${itemName}: ${mintOutpoint}`);

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

    console.log('🔀 [MERGE] Creating merge transaction:', {
      input1: transferredTokenId, input1Amt: currentQuantity,
      input2: mintOutpoint, input2Amt: addedQuantity,
      outputAmt: newQuantity,
    });

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

    const reference = mergeActionRes.signableTransaction.reference;
    const txToSign = Transaction.fromBEEF(mergeActionRes.signableTransaction.tx);

    txToSign.inputs[0].unlockingScriptTemplate = transferredUnlock;
    txToSign.inputs[0].sourceTransaction = transferTransaction;
    txToSign.inputs[1].unlockingScriptTemplate = mintedUnlock;
    txToSign.inputs[1].sourceTransaction = mintTx;

    await txToSign.sign();

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

    const mergeTx = Transaction.fromAtomicBEEF(mergeAction.tx);
    const mergeBroadcast = await broadcastTX(mergeTx);
    const mergeTxId = mergeBroadcast.txid!;
    const mergedTokenId = `${mergeTxId}.0`;

    console.log(`✅ [MERGE] Merged tokens: ${mergedTokenId} (${newQuantity}x ${itemName})`);

    // Update the DB index and return the BEEF + nonce.

    await materialTokensCollection.updateOne(
      { _id: existingToken._id },
      {
        $set: {
          tokenId: mergedTokenId,
          quantity: newQuantity,
          metadata: materialMetadata,
          previousTokenId: transferredTokenId,
          lastTransactionId: mergeTxId,
          keyId: N3,
          counterparty: serverIdentityKey,
          updatedAt: new Date(),
        },
        $push: {
          updateHistory: {
            operation: 'add',
            previousQuantity: currentQuantity,
            newQuantity,
            transactionId: mergeTxId,
            mergedFrom: [transferredTokenId, mintOutpoint],
            reason: reason || 'Material addition (server merge)',
            timestamp: new Date(),
          },
        },
      }
    );

    // Consume the unminted UserInventory items that fed the added quantity.
    if (Array.isArray(inventoryItemIds) && inventoryItemIds.length > 0) {
      const { ObjectId } = await import('mongodb');
      const objectIds = inventoryItemIds.map((id: string) => new ObjectId(id));
      const deleteResult = await userInventoryCollection.deleteMany({ _id: { $in: objectIds }, userId });
      console.log(`✅ [CONSUME] Removed ${deleteResult.deletedCount} UserInventory items after merging ${itemName}`);
    }

    console.log('✅ [DATABASE] Updated material token document');

    return NextResponse.json({
      success: true,
      mergedTokenId,
      mergeTransactionId: mergeTxId,
      newQuantity,
      previousQuantity: currentQuantity,
      addedQuantity,
      transferBeef: encodeBeef(Array.from(mergeAction.tx!)),
      received: {
        outputIndex: 0,
        keyId: N3,
        counterparty: serverIdentityKey,
        tags: ['type:material'],
      },
    });

  } catch (error) {
    console.error('Add and merge error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add and merge materials' },
      { status: 500 }
    );
  }
}

// Single-tx mint: server builds/funds/signs one deploy+mint locked directly to
// the user's recipient-derived key (so mintOutpoint === tokenId). Returns the
// BEEF + nonce for the client to internalize into its wallet basket.

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';
import { getServerWallet, getServerIdentityPublicKey } from '@/lib/serverWallet';
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';
import { Transaction } from '@bsv/sdk';
import { WalletP2PKH } from '@bsv/wallet-helper';
import { ObjectId } from 'mongodb';
import { broadcastTX } from '@/utils/overlayFunctions';
import { decodeBeef, encodeBeef } from '@/utils/beefEncoding';
import { generateNonce, deriveRecipientKey } from '@/utils/tokenDerivation';

export async function POST(request: NextRequest) {
  try {
    // 1. Verify JWT and get user
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const payload = await verifyJWT(token);
    const userId = payload.userId;

    // 2. Parse request body
    const body = await request.json();
    const {
      inventoryItemId,  // UserInventory document ID (validate ownership)
      itemData,         // Full item metadata for minting
      userIdentityKey,  // User's IDENTITY key — the derivation counterparty
      paymentTx,        // base64 WalletP2PKH payment BEEF
      walletParams,     // Wallet derivation params for unlocking { protocolID, keyID, counterparty }
    } = body;

    // Validate required fields
    if (!inventoryItemId || !itemData || !userIdentityKey) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    if (!paymentTx) {
      return NextResponse.json(
        { error: 'Missing payment transaction' },
        { status: 400 }
      );
    }

    if (!walletParams || !walletParams.protocolID || !walletParams.keyID || !walletParams.counterparty) {
      return NextResponse.json(
        { error: 'Missing wallet derivation parameters' },
        { status: 400 }
      );
    }

    // 3. Connect to MongoDB and validate ownership
    const { userInventoryCollection, nftLootCollection } = await connectToMongo();
    const inventoryItem = await userInventoryCollection.findOne({
      _id: new ObjectId(inventoryItemId),
      userId: userId,
    });

    if (!inventoryItem) {
      return NextResponse.json(
        { error: 'Item not found or not owned by user' },
        { status: 404 }
      );
    }

    // Check if already minted
    if (inventoryItem.nftLootId) {
      return NextResponse.json(
        { error: 'Item already minted' },
        { status: 400 }
      );
    }

    // 4. Get server wallet
    const serverWallet = await getServerWallet();

    // 5. Decode base64 payment BEEF and parse the payment transaction
    const paymentBeef = decodeBeef(paymentTx);
    const paymentTransaction = Transaction.fromBEEF(paymentBeef);
    const paymentTxId = paymentTransaction.id('hex');

    console.log('📥 [PAYMENT] Received WalletP2PKH payment transaction:', {
      txid: paymentTxId,
      walletParams,
    });

    console.log('📥 [PAYMENT] Parsed payment transaction:', {
      txid: paymentTxId,
      inputs: paymentTransaction.inputs.length,
      outputs: paymentTransaction.outputs.length,
      output0Satoshis: paymentTransaction.outputs[0]?.satoshis,
      output0Script: paymentTransaction.outputs[0]?.lockingScript.toHex(),
    });

    // Find output locked to server with WalletP2PKH (should be output 0)
    const paymentOutput = paymentTransaction.outputs[0];
    if (!paymentOutput || !paymentOutput.satoshis || paymentOutput.satoshis < 90) {
      return NextResponse.json(
        { error: 'Invalid payment: must be at least 100 (10% variance) satoshis' },
        { status: 400 }
      );
    }

    const paymentOutpoint = `${paymentTxId}.0`;

    // Create WalletP2PKH unlocking script template using wallet params from client
    const walletp2pkh = new WalletP2PKH(serverWallet);
    const walletP2pkhUnlockTemplate = walletp2pkh.unlock({
      protocolID: walletParams.protocolID,
      keyID: walletParams.keyID,
      counterparty: walletParams.counterparty,
    });
    const walletP2pkhUnlockingLength = await walletP2pkhUnlockTemplate.estimateLength();

    console.log('🔓 [PAYMENT] Created WalletP2PKH unlock template:', {
      unlockingScriptLength: walletP2pkhUnlockingLength,
      paymentOutpoint,
      protocolID: walletParams.protocolID,
      keyID: walletParams.keyID,
      counterparty: walletParams.counterparty,
    });

    // Mint directly to the user's recipient-derived key (single tx).
    const ordinalP2PKH = new OrdinalsP2PKH();
    const nonce = generateNonce();
    const serverIdentityKey = await getServerIdentityPublicKey();
    const userKey = await deriveRecipientKey(serverWallet, userIdentityKey, nonce);
    const mintLockingScript = ordinalP2PKH.lock(userKey, '', itemData, 'deploy+mint');

    console.log('🔨 [MINT-ITEM] Creating deploy+mint locked to user:', {
      operation: 'deploy+mint',
      userKey,
      itemName: itemData.itemName || itemData.name,
      scriptLength: mintLockingScript.toHex().length,
    });

    // Step 1: Call createAction with unlockingScriptLength
    const mintActionRes = await serverWallet.createAction({
      description: "Server minting item NFT with user WalletP2PKH payment",
      inputBEEF: paymentBeef,
      inputs: [
        {
          inputDescription: "User WalletP2PKH payment for fees",
          outpoint: paymentOutpoint,
          unlockingScriptLength: walletP2pkhUnlockingLength,
        }
      ],
      outputs: [
        {
          outputDescription: "New NFT item",
          lockingScript: mintLockingScript.toHex(),
          satoshis: 1,
        }
      ],
      options: {
        randomizeOutputs: false,
        acceptDelayedBroadcast: false,
      }
    });

    if (!mintActionRes.signableTransaction) {
      throw new Error('Failed to create signable mint transaction');
    }

    // Step 2: Extract signable transaction and sign it
    const mintReference = mintActionRes.signableTransaction.reference;
    const mintTxToSign = Transaction.fromBEEF(mintActionRes.signableTransaction.tx);

    // Add WalletP2PKH unlocking script template and source transaction
    mintTxToSign.inputs[0].unlockingScriptTemplate = walletP2pkhUnlockTemplate;
    mintTxToSign.inputs[0].sourceTransaction = paymentTransaction;

    // Sign the transaction
    await mintTxToSign.sign();

    // Extract the unlocking script
    const mintUnlockingScript = mintTxToSign.inputs[0].unlockingScript;
    if (!mintUnlockingScript) {
      throw new Error('Missing unlocking script after signing');
    }

    console.log('🔓 [MINT-ITEM] Transaction signed, WalletP2PKH unlocking script generated:', {
      scriptLength: mintUnlockingScript.toHex().length,
      scriptHex: mintUnlockingScript.toHex(),
    });

    // Step 3: Sign the action with actual unlocking scripts
    const mintAction = await serverWallet.signAction({
      reference: mintReference,
      spends: {
        '0': { unlockingScript: mintUnlockingScript.toHex() }
      }
    });

    if (!mintAction.tx) {
      throw new Error('Failed to sign mint action');
    }

    // Broadcast mint transaction
    const mintTx = Transaction.fromAtomicBEEF(mintAction.tx);

    console.log('📦 [MINT] Transaction structure before broadcast:', {
      txid: mintTx.id('hex'),
      inputs: mintTx.inputs.length,
      outputs: mintTx.outputs.length,
      outputSatoshis: mintTx.outputs.map(o => o.satoshis),
      txHex: mintTx.toHex(),
    });

    const mintBroadcast = await broadcastTX(mintTx);
    const mintTxId = mintBroadcast.txid;

    if (!mintTxId) {
      throw new Error('Failed to get transaction ID from broadcast');
    }

    const tokenId = `${mintTxId}.0`; // mint proof and current location are the same outpoint

    console.log('✅ [MINT] Minted item directly to user:', { mintTxId, tokenId, nonce });

    const nftLootDoc = {
      lootTableId: inventoryItem.lootTableId,
      name: itemData.name || itemData.itemName,
      description: itemData.description,
      icon: itemData.icon,
      rarity: itemData.rarity,
      type: inventoryItem.itemType,
      attributes: itemData,
      mintOutpoint: tokenId,
      tokenId: tokenId,
      createdAt: new Date(),
    };

    const nftResult = await nftLootCollection.insertOne(nftLootDoc);
    const nftLootId = nftResult.insertedId.toString();

    // Persist outpoint + derivation index on the inventory item.
    await userInventoryCollection.updateOne(
      { _id: new ObjectId(inventoryItemId) },
      {
        $set: {
          nftLootId: nftResult.insertedId,
          mintOutpoint: tokenId,
          tokenId: tokenId,
          keyId: nonce,
          counterparty: serverIdentityKey,
          updatedAt: new Date(),
        }
      }
    );

    return NextResponse.json({
      success: true,
      nftId: nftLootId,
      tokenId: tokenId,
      mintOutpoint: tokenId,
      transferBeef: encodeBeef(Array.from(mintAction.tx!)),
      received: {
        outputIndex: 0,
        keyId: nonce,
        counterparty: serverIdentityKey,
        tags: ['type:item'],
      },
    });

  } catch (error) {
    console.error('Mint and transfer error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to mint and transfer item' },
      { status: 500 }
    );
  }
}

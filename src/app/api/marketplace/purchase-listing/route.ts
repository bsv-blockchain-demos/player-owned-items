import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { getServerWallet } from '@/lib/serverWallet';
import { WalletOrdLock } from '@bsv/wallet-helper';
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';
import { Beef, Transaction, Script, P2PKH } from '@bsv/sdk';
import { broadcastTX, getTransactionByTxID } from '@/utils/overlayFunctions';
import { WalletP2PKH } from '@bsv/wallet-helper';

/**
 * POST /api/marketplace/purchase-listing
 * Purchase a marketplace listing
 * Uses OrdLock.purchaseListing() with specific output structure:
 * - Output 0: Transfer item to buyer
 * - Output 1: Payment to seller (must match payout in OrdLock)
 * - Output 2+: Marketplace fees (optional)
 */
export async function POST(request: NextRequest) {
  try {
    // Get cookies using next/headers
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    const userId = payload.userId as string;

    const body = await request.json();
    const {
      listingId,
      buyerPublicKey,
      paymentTx,
      walletParams,
    } = body;

    // Validate required fields
    if (!listingId || !buyerPublicKey || !paymentTx || !walletParams) {
      return NextResponse.json(
        { error: 'Missing required fields: listingId, buyerPublicKey, paymentTx, walletParams' },
        { status: 400 }
      );
    }

    const { marketplaceItemsCollection, userInventoryCollection, materialTokensCollection, usersCollection } = await connectToMongo();

    // Fetch the listing
    const listing = await marketplaceItemsCollection.findOne({
      _id: new ObjectId(listingId),
      status: 'active'
    });

    if (!listing) {
      return NextResponse.json(
        { error: 'Listing not found or already cancelled/sold' },
        { status: 404 }
      );
    }

    // Can't buy your own listing
    if (listing.sellerId === userId) {
      return NextResponse.json(
        { error: 'You cannot purchase your own listing' },
        { status: 400 }
      );
    }

    // Ensure listing has OrdLock data
    if (!listing.ordLockOutpoint || !listing.ordLockScript || !listing.assetId || !listing.payAddress) {
      return NextResponse.json(
        { error: 'Listing is missing OrdLock data' },
        { status: 400 }
      );
    }

    console.log('💰 [PURCHASE-LISTING] Starting purchase:', {
      listingId,
      itemName: listing.itemName,
      price: listing.price,
      ordLockOutpoint: listing.ordLockOutpoint,
    });

    // ===== CREATE PURCHASE TRANSACTION =====

    const serverWallet = await getServerWallet();

    // Parse payment transaction
    const paymentTransaction = Transaction.fromBEEF(paymentTx);
    const paymentTxId = paymentTransaction.id('hex');
    const paymentOutpoint = `${paymentTxId}.0`;

    console.log('📥 [PURCHASE-LISTING] Payment transaction:', {
      txid: paymentTxId,
      paymentOutpoint,
    });

    // Fetch the OrdLock transaction for spending
    const [ordLockTxId, ordLockVout] = listing.ordLockOutpoint.split('.');
    const ordLockTxData = await getTransactionByTxID(ordLockTxId);

    if (!ordLockTxData || !ordLockTxData.outputs || !ordLockTxData.outputs[parseInt(ordLockVout)] || !ordLockTxData.outputs[parseInt(ordLockVout)].beef) {
      throw new Error(`Could not find OrdLock transaction: ${ordLockTxId}`);
    }

    const ordLockTransaction = Transaction.fromBEEF(ordLockTxData.outputs[parseInt(ordLockVout)].beef!);
    const ordLockScript = Script.fromHex(listing.ordLockScript);

    console.log('📥 [PURCHASE-LISTING] OrdLock transaction:', {
      txid: ordLockTxId,
      vout: ordLockVout,
      ordLockOutpoint: listing.ordLockOutpoint,
    });

    // Create purchase unlock template
    const ordLock = new WalletOrdLock();
    const purchaseUnlockTemplate = ordLock.purchaseUnlock({
      sourceSatoshis: 1,
      lockingScript: ordLockScript,
    });

    console.log('🔓 [PURCHASE-LISTING] Created purchase unlock template');

    // Create transfer locking script (item to buyer)
    const ordinalP2PKH = new OrdinalsP2PKH();
    const transferLockingScript = ordinalP2PKH.lock(
      buyerPublicKey,
      listing.assetId,
      listing, // Item metadata
      'transfer'
    );

    console.log('🔒 [PURCHASE-LISTING] Created transfer locking script:', {
      operation: 'transfer',
      assetId: listing.assetId,
      buyerPublicKey,
      scriptLength: transferLockingScript.toHex().length,
    });

    // Create payment locking script (payment to seller)
    // This MUST match the payout in OrdLock (address and amount)
    const sellerPaymentScript = new P2PKH().lock(listing.payAddress);

    console.log('💵 [PURCHASE-LISTING] Created seller payment script:', {
      payAddress: listing.payAddress,
      price: listing.price,
    });

    // Create unlocking templates for payment input
    const walletp2pkh = new WalletP2PKH(serverWallet);
    const paymentUnlockTemplate = walletp2pkh.unlock({
      protocolID: walletParams.protocolID,
      keyID: walletParams.keyID,
      counterparty: walletParams.counterparty,
    });
    const paymentUnlockingLength = await paymentUnlockTemplate.estimateLength();

    // Validate payment is sufficient
    const feeBufferSatoshis = 100;
    const requiredPayment = listing.price + feeBufferSatoshis;
    if (!paymentTransaction.outputs[0] || (paymentTransaction.outputs[0].satoshis || 0) < requiredPayment) {
      return NextResponse.json(
        { error: `Invalid payment amount. Required: ${requiredPayment} sats (price ${listing.price} + ${feeBufferSatoshis} sats fees)` },
        { status: 400 }
      );
    }

    // Build outputs array
    const outputs: Array<{
      outputDescription: string;
      lockingScript: string;
      satoshis: number;
    }> = [
        {
          outputDescription: "Transfer item to buyer",
          lockingScript: transferLockingScript.toHex(),
          satoshis: 1,
        },
        {
          outputDescription: "Payment to seller",
          lockingScript: sellerPaymentScript.toHex(),
          satoshis: listing.price,
        }
      ];

    const mergedBeef = new Beef();
    mergedBeef.mergeBeef(ordLockTransaction.toBEEF());
    mergedBeef.mergeBeef(paymentTransaction.toBEEF());
    const inputBEEF = mergedBeef.toBinary();

    // STEP 1: createAction - Prepare transaction
    // OrdLock purchase unlocking script length depends on the final transaction outputs,
    // so we do a quick two-pass createAction: first with a conservative placeholder,
    // then compute the exact length from the signable transaction and recreate.
    const ordLockUnlockingLengthPlaceholder = 400;
    let actionRes = await serverWallet.createAction({
      description: "Purchasing marketplace item",
      inputBEEF,
      inputs: [
        {
          inputDescription: "OrdLock UTXO to purchase",
          outpoint: listing.ordLockOutpoint,
          unlockingScriptLength: ordLockUnlockingLengthPlaceholder,
        },
        {
          inputDescription: "Buyer payment for item and fees",
          outpoint: paymentOutpoint,
          unlockingScriptLength: paymentUnlockingLength,
        }
      ],
      outputs,
      options: {
        randomizeOutputs: false,
        acceptDelayedBroadcast: false,
      }
    });

    if (!actionRes.signableTransaction) {
      throw new Error('Failed to create signable transaction');
    }

    const txForLength = Transaction.fromBEEF(actionRes.signableTransaction.tx);
    const ordLockUnlockingLength = await purchaseUnlockTemplate.estimateLength(txForLength, 0);
    const ordLockUnlockingLengthWithBuffer = ordLockUnlockingLength + 68;

    actionRes = await serverWallet.createAction({
      description: "Purchasing marketplace item",
      inputBEEF,
      inputs: [
        {
          inputDescription: "OrdLock UTXO to purchase",
          outpoint: listing.ordLockOutpoint,
          unlockingScriptLength: ordLockUnlockingLengthWithBuffer,
        },
        {
          inputDescription: "Buyer payment for item and fees",
          outpoint: paymentOutpoint,
          unlockingScriptLength: paymentUnlockingLength,
        }
      ],
      outputs,
      options: {
        randomizeOutputs: false,
        acceptDelayedBroadcast: false,
      }
    });

    if (!actionRes.signableTransaction) {
      throw new Error('Failed to create signable transaction');
    }

    // STEP 2: Sign - Generate unlocking scripts
    const reference = actionRes.signableTransaction.reference;
    const txToSign = Transaction.fromBEEF(actionRes.signableTransaction.tx);

    // Attach templates and source transactions
    txToSign.inputs[0].unlockingScriptTemplate = purchaseUnlockTemplate;
    txToSign.inputs[0].sourceTransaction = ordLockTransaction;
    txToSign.inputs[1].unlockingScriptTemplate = paymentUnlockTemplate;
    txToSign.inputs[1].sourceTransaction = paymentTransaction;

    // Sign the transaction (this generates the OrdLock purchase unlocking script)
    await txToSign.sign();

    // Extract unlocking scripts
    const ordLockUnlockingScript = txToSign.inputs[0].unlockingScript;
    const paymentUnlockingScript = txToSign.inputs[1].unlockingScript;

    if (!ordLockUnlockingScript || !paymentUnlockingScript) {
      throw new Error('Missing unlocking scripts after signing');
    }

    console.log('🔓 [PURCHASE-LISTING] Transaction signed, unlocking scripts generated');

    // STEP 3: signAction - Finalize transaction
    const action = await serverWallet.signAction({
      reference,
      spends: {
        '0': { unlockingScript: ordLockUnlockingScript.toHex() },
        '1': { unlockingScript: paymentUnlockingScript.toHex() }
      }
    });

    if (!action.tx) {
      throw new Error('Failed to sign action');
    }

    // Broadcast transaction
    const tx = Transaction.fromAtomicBEEF(action.tx);
    const broadcast = await broadcastTX(tx);
    const txid = broadcast.txid;

    if (!txid) {
      throw new Error('Failed to get transaction ID from broadcast');
    }

    const buyerTokenId = `${txid}.0`;

    console.log('✅ [PURCHASE-LISTING] Purchase transaction broadcast:', {
      txid,
      buyerTokenId,
    });

    // Update marketplace listing status
    await marketplaceItemsCollection.updateOne(
      { _id: new ObjectId(listingId) },
      {
        $set: {
          status: 'sold',
          soldAt: new Date(),
          soldTo: userId,
        }
      }
    );

    // Get buyer user info
    const buyerUser = await usersCollection.findOne({ userId });
    if (!buyerUser) {
      throw new Error('Buyer user not found');
    }

    // Transfer item ownership in database
    if (listing.inventoryItemId) {
      // Transfer inventory item to buyer
      await userInventoryCollection.updateOne(
        { _id: new ObjectId(listing.inventoryItemId) },
        {
          $set: {
            userId: userId, // New owner
            tokenId: buyerTokenId,
            updatedAt: new Date(),
          }
        }
      );
    } else if (listing.materialTokenId) {
      // Transfer material token to buyer
      await materialTokensCollection.updateOne(
        { _id: new ObjectId(listing.materialTokenId) },
        {
          $set: {
            userId: userId, // New owner
            tokenId: buyerTokenId,
            updatedAt: new Date(),
          }
        }
      );
    }

    console.log('[MARKETPLACE PURCHASE] Item purchased:', {
      listingId,
      itemName: listing.itemName,
      price: listing.price,
      buyerId: userId,
      buyerTokenId,
    });

    return NextResponse.json({
      success: true,
      buyerTokenId,
      message: `${listing.itemName} purchased for ${listing.price} satoshis`,
    });

  } catch (error) {
    console.error('Error purchasing listing:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to purchase listing' },
      { status: 500 }
    );
  }
}

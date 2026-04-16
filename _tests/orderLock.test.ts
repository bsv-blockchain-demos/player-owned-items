import {
  Transaction,
  PrivateKey,
  MerklePath,
  Script,
  Utils,
  P2PKH,
  PublicKey
} from '@bsv/sdk';
import { OrdinalsP2PKH } from '../src/utils/ordinalP2PKH';
import { WalletOrdLock as OrdLock } from '@bsv/wallet-helper';
import { makeWallet } from './helpers/mockWallet';

describe('OrdLock - Marketplace Transaction Validation', () => {
  const storageURL = 'https://store-us-1.bsvb.tech';

  describe('Create listing from NFT', () => {
    it('should create a valid orderLock listing from an ordinalP2PKH NFT', async () => {
      // Setup: User has an NFT (ordinalP2PKH) and wants to list it for sale
      const sellerPriv = new PrivateKey(100);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      // Step 1: Create source NFT transaction (ordinalP2PKH)
      const assetId = 'dragon_sword_txid_0';
      const itemData = {
        name: 'Dragon Sword',
        rarity: 'legendary',
        type: 'weapon',
        damageBonus: 100,
        tier: 5
      };

      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      // Create ordinalP2PKH NFT
      const nftLockingScript = new OrdinalsP2PKH().lock(
        sellerPubKey,
        assetId,
        itemData,
        'transfer' // Already minted NFT
      );

      nftTransaction.addOutput({
        lockingScript: nftLockingScript,
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        1234
      );

      // Step 2: Create orderLock listing transaction
      const listPrice = 1000; // sats
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();

      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      // Create orderLock locking script
      const orderLock = new OrdLock();
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: listPrice,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      const isValid = await listingTx.verify('scripts only');
      expect(isValid).toBe(true);

      // Verify the listing contains the inscription
      const outputScript = listingTx.outputs[0].lockingScript.toHex();
      const scriptAscii = Buffer.from(outputScript, 'hex').toString('ascii');
      expect(scriptAscii).toContain('bsv-20');
      expect(scriptAscii).toContain('transfer');
      expect(scriptAscii).toContain(assetId);
    }, 30000);

    it('should preserve complex item metadata in orderLock listing', async () => {
      const sellerPriv = new PrivateKey(101);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'excalibur_txid_0';
      const complexItemData = {
        name: 'Legendary Excalibur',
        type: 'weapon',
        rarity: 'legendary',
        tier: 5,
        stats: {
          damageBonus: 150,
          critChance: 75,
          autoClickRate: 1
        },
        inscriptions: {
          prefix: { type: 'Godly', value: 25 },
          suffix: { type: 'of Devastation', value: 30 }
        },
        crafted: true,
        statRoll: 1.18
      };

      // Create NFT
      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      nftTransaction.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          sellerPubKey,
          assetId,
          complexItemData,
          'transfer'
        ),
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        5000
      );

      // Create listing
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();
      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      const orderLock = new OrdLock();
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: 5000,
        assetId,
        itemData: complexItemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      const isValid = await listingTx.verify('scripts only');
      expect(isValid).toBe(true);

      // Verify metadata preservation
      const outputScript = listingTx.outputs[0].lockingScript.toHex();
      const scriptAscii = Buffer.from(outputScript, 'hex').toString('ascii');
      expect(scriptAscii).toContain('Legendary Excalibur');
      expect(scriptAscii).toContain('Godly');
      expect(scriptAscii).toContain('of Devastation');
    }, 30000);
  });

  describe('Cancel listing', () => {
    it('should allow seller to cancel listing and reclaim NFT', async () => {
      // Setup: Seller has listed an item and wants to cancel
      const sellerPriv = new PrivateKey(102);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'cancel_test_txid_0';
      const itemData = {
        name: 'Iron Shield',
        type: 'armor',
        defense: 50
      };

      // Create NFT
      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      nftTransaction.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          sellerPubKey,
          assetId,
          itemData,
          'transfer'
        ),
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        2000
      );

      // Create listing
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();
      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      const orderLock = new OrdLock(sellerWallet);
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: 2000,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      listingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        listingTx.id('hex'),
        2001
      );

      // Step 3: Cancel the listing
      const cancelTx = new Transaction();

      cancelTx.addInput({
        sourceTransaction: listingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: orderLock.cancelUnlock({
          protocolID: [0, "monsterbattle"],
          keyID: "0",
          counterparty: "self",
        })
      });

      // Return NFT to seller's ordinalP2PKH
      cancelTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          sellerPubKey,
          assetId,
          { ...itemData, cancelled: true },
          'transfer'
        ),
        satoshis: 1
      });

      await cancelTx.fee();
      await cancelTx.sign();

      const isValid = await cancelTx.verify('scripts only');
      expect(isValid).toBe(true);
    }, 30000);

    it('should work with different signature scopes for cancellation', async () => {
      const sellerPriv = new PrivateKey(103);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'scope_test_txid_0';
      const itemData = { name: 'Test Item' };

      // Create NFT
      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      nftTransaction.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(sellerPubKey, assetId, itemData, 'transfer'),
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        3000
      );

      // Create listing
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();
      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      const orderLock = new OrdLock(sellerWallet);
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: 1000,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      listingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        listingTx.id('hex'),
        3001
      );

      // Cancel with 'all' signature scope
      const cancelTx = new Transaction();

      cancelTx.addInput({
        sourceTransaction: listingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: orderLock.cancelUnlock({
          protocolID: [0, "monsterbattle"],
          keyID: "0",
          counterparty: "self",
          signOutputs: 'all',
        })
      });

      cancelTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(sellerPubKey, assetId, itemData, 'transfer'),
        satoshis: 1
      });

      await cancelTx.fee();
      await cancelTx.sign();

      const isValid = await cancelTx.verify('scripts only');
      expect(isValid).toBe(true);
    }, 30000);
  });

  describe('Purchase listing', () => {
    it('should allow buyer to purchase listing with P2PKH payment', async () => {
      // Setup: Two users - seller has listing, buyer wants to purchase
      const sellerPriv = new PrivateKey(104);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const buyerPriv = new PrivateKey(105);
      const buyerWallet = await makeWallet('main', storageURL, buyerPriv.toHex());

      const { publicKey: buyerPubKey } = await buyerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'purchase_test_txid_0';
      const itemData = {
        name: 'Rare Amulet',
        type: 'artifact',
        rarity: 'rare'
      };
      const listPrice = 5000; // sats

      // Step 1: Create NFT owned by seller
      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      nftTransaction.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(sellerPubKey, assetId, itemData, 'transfer'),
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        4000
      );

      // Step 2: Seller creates listing
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();
      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      const orderLock = new OrdLock();
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: listPrice,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      listingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        listingTx.id('hex'),
        4001
      );

      // Step 3: Buyer creates funding transaction
      // Use raw private key address for P2PKH funding UTXO (must match P2PKH.unlock(buyerPriv))
      const buyerFundingAddress = buyerPriv.toPublicKey().toAddress();
      const buyerPkh = Utils.fromBase58Check(buyerFundingAddress).data as number[];

      // Create a P2PKH funding UTXO for the buyer
      const fundingTx = new Transaction();
      fundingTx.addInput({
        sourceTXID: '1111111111111111111111111111111111111111111111111111111111111111',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      fundingTx.addOutput({
        lockingScript: new P2PKH().lock(buyerPkh),
        satoshis: listPrice + 1000 // Enough for payment + fees
      });

      fundingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        fundingTx.id('hex'),
        4002
      );

      // Step 4: Buyer purchases the listing
      const purchaseTx = new Transaction();

      // Input 0: The orderLock listing (contains NFT)
      const listingOutput = listingTx.outputs[0];
      purchaseTx.addInput({
        sourceTransaction: listingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: orderLock.purchaseUnlock({
          sourceSatoshis: 1,
          lockingScript: listingOutput.lockingScript
        })
      });

      // Input 1: Buyer's funding UTXO (provides payment)
      purchaseTx.addInput({
        sourceTransaction: fundingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(
          buyerPriv,
          'all',
          true, // anyoneCanPay = true (important for orderLock!)
          fundingTx.outputs[0].satoshis,
          fundingTx.outputs[0].lockingScript
        )
      });

      // Output 0: NFT goes to buyer (ordinalP2PKH)
      purchaseTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          buyerPubKey,
          assetId,
          { ...itemData, purchasedBy: 'buyer' },
          'transfer'
        ),
        satoshis: 1
      });

      // Output 1: Payment to seller (P2PKH)
      const sellerPkh = Utils.fromBase58Check(sellerAddress).data as number[];
      purchaseTx.addOutput({
        lockingScript: new P2PKH().lock(sellerPkh),
        satoshis: listPrice
      });

      await purchaseTx.sign();

      const isValid = await purchaseTx.verify('scripts only');
      expect(isValid).toBe(true);

      // Verify buyer owns the NFT now
      const nftOutput = purchaseTx.outputs[0].lockingScript.toHex();
      const nftAscii = Buffer.from(nftOutput, 'hex').toString('ascii');
      expect(nftAscii).toContain(assetId);
      expect(nftAscii).toContain('purchasedBy');
    }, 30000);

    it('should handle purchase with change outputs', async () => {
      const sellerPriv = new PrivateKey(106);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const buyerPriv = new PrivateKey(107);
      const buyerWallet = await makeWallet('main', storageURL, buyerPriv.toHex());

      const { publicKey: buyerPubKey } = await buyerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'change_test_txid_0';
      const itemData = { name: 'Potion of Healing' };
      const listPrice = 1000;

      // Create NFT
      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      nftTransaction.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(sellerPubKey, assetId, itemData, 'transfer'),
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        5000
      );

      // Create listing
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();
      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      const orderLock = new OrdLock();
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: listPrice,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      listingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        listingTx.id('hex'),
        5001
      );

      // Create buyer funding UTXO (use raw private key address to match P2PKH.unlock)
      const buyerFundingAddress = buyerPriv.toPublicKey().toAddress();
      const buyerPkh = Utils.fromBase58Check(buyerFundingAddress).data as number[];
      const fundingTx = new Transaction();
      fundingTx.addInput({
        sourceTXID: '1111111111111111111111111111111111111111111111111111111111111111',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      fundingTx.addOutput({
        lockingScript: new P2PKH().lock(buyerPkh),
        satoshis: listPrice + 1000 // Enough for payment + fees
      });

      fundingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        fundingTx.id('hex'),
        5002
      );

      // Purchase with change output
      const purchaseTx = new Transaction();

      // Input 0: orderLock listing
      const listingOutput2 = listingTx.outputs[0];
      purchaseTx.addInput({
        sourceTransaction: listingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: orderLock.purchaseUnlock({
          sourceSatoshis: 1,
          lockingScript: listingOutput2.lockingScript
        })
      });

      // Input 1: Buyer's funding
      purchaseTx.addInput({
        sourceTransaction: fundingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(
          buyerPriv,
          'all',
          true, // anyoneCanPay = true
          fundingTx.outputs[0].satoshis,
          fundingTx.outputs[0].lockingScript
        )
      });

      // Output 0: NFT to buyer
      purchaseTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(buyerPubKey, assetId, itemData, 'transfer'),
        satoshis: 1
      });

      // Output 1: Payment to seller
      const sellerPkh2 = Utils.fromBase58Check(sellerAddress).data as number[];
      purchaseTx.addOutput({
        lockingScript: new P2PKH().lock(sellerPkh2),
        satoshis: listPrice
      });

      // Output 2: Change back to buyer
      purchaseTx.addOutput({
        lockingScript: new P2PKH().lock(buyerPkh),
        satoshis: 500 // Change
      });

      await purchaseTx.sign();

      const isValid = await purchaseTx.verify('scripts only');
      expect(isValid).toBe(true);
    }, 30000);

    it('should validate payment amount matches listing price', async () => {
      const sellerPriv = new PrivateKey(108);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const buyerPriv = new PrivateKey(109);
      const buyerWallet = await makeWallet('main', storageURL, buyerPriv.toHex());

      const { publicKey: buyerPubKey } = await buyerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'price_validation_txid_0';
      const itemData = { name: 'Legendary Gem' };
      const listPrice = 10000;

      // Create NFT
      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      nftTransaction.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(sellerPubKey, assetId, itemData, 'transfer'),
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        6000
      );

      // Create listing
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();
      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      const orderLock = new OrdLock();
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: listPrice,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      listingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        listingTx.id('hex'),
        6001
      );

      // Create buyer funding UTXO (use raw private key address to match P2PKH.unlock)
      const buyerFundingAddress = buyerPriv.toPublicKey().toAddress();
      const buyerPkh = Utils.fromBase58Check(buyerFundingAddress).data as number[];
      const fundingTx = new Transaction();
      fundingTx.addInput({
        sourceTXID: '1111111111111111111111111111111111111111111111111111111111111111',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      fundingTx.addOutput({
        lockingScript: new P2PKH().lock(buyerPkh),
        satoshis: listPrice + 1000
      });

      fundingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        fundingTx.id('hex'),
        6002
      );

      // Purchase with correct price
      const purchaseTx = new Transaction();

      // Input 0: orderLock listing
      const listingOutput2 = listingTx.outputs[0];
      purchaseTx.addInput({
        sourceTransaction: listingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: orderLock.purchaseUnlock({
          sourceSatoshis: 1,
          lockingScript: listingOutput2.lockingScript
        })
      });

      // Input 1: Buyer's funding
      purchaseTx.addInput({
        sourceTransaction: fundingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(
          buyerPriv,
          'all',
          true, // anyoneCanPay = true
          fundingTx.outputs[0].satoshis,
          fundingTx.outputs[0].lockingScript
        )
      });

      purchaseTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(buyerPubKey, assetId, itemData, 'transfer'),
        satoshis: 1
      });

      // Exactly the list price
      const sellerPkh3 = Utils.fromBase58Check(sellerAddress).data as number[];
      purchaseTx.addOutput({
        lockingScript: new P2PKH().lock(sellerPkh3),
        satoshis: listPrice // Must match exactly
      });

      await purchaseTx.sign();

      const isValid = await purchaseTx.verify('scripts only');
      expect(isValid).toBe(true);
    }, 30000);
  });

  describe('Edge cases', () => {
    it('should handle listing of high-tier crafted items with inscriptions', async () => {
      const sellerPriv = new PrivateKey(110);
      const sellerWallet = await makeWallet('main', storageURL, sellerPriv.toHex());

      const { publicKey: sellerPubKey } = await sellerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'crafted_legendary_txid_0';
      const complexItemData = {
        name: 'Empowered Dragon Slayer Excalibur',
        type: 'weapon',
        rarity: 'legendary',
        tier: 5,
        crafted: true,
        statRoll: 1.2,
        empowered: true,
        empoweredLevel: 10,
        stats: {
          damageBonus: 200,
          critChance: 90,
          critDamage: 250,
          lifesteal: 10,
          autoClickRate: 2
        },
        inscriptions: {
          prefix: {
            type: 'Godly',
            lootTableId: 'legendary_prefix_godly',
            stats: { damageBonus: 25 }
          },
          suffix: {
            type: 'of the Apocalypse',
            lootTableId: 'legendary_suffix_apocalypse',
            stats: { critDamage: 50 }
          }
        },
        borderGradient: {
          color1: '#aa8e53',
          color2: '#5392d4'
        }
      };

      // Create NFT
      const nftTransaction = new Transaction();
      nftTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      nftTransaction.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          sellerPubKey,
          assetId,
          complexItemData,
          'transfer'
        ),
        satoshis: 1
      });

      nftTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        nftTransaction.id('hex'),
        7000
      );

      // Create listing at high price
      const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress();
      const listingTx = new Transaction();

      listingTx.addInput({
        sourceTransaction: nftTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(sellerWallet)
      });

      const orderLock = new OrdLock();
      const orderLockScript = await orderLock.lock({
        ordAddress: sellerAddress,
        payAddress: sellerAddress,
        price: 100000, // High price for legendary item
        assetId,
        itemData: complexItemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listingTx.addOutput({
        lockingScript: orderLockScript,
        satoshis: 1
      });

      await listingTx.fee();
      await listingTx.sign();

      const isValid = await listingTx.verify('scripts only');
      expect(isValid).toBe(true);

      // Verify all metadata is preserved in orderLock
      const outputScript = listingTx.outputs[0].lockingScript.toHex();
      const scriptAscii = Buffer.from(outputScript, 'hex').toString('ascii');
      expect(scriptAscii).toContain('Empowered Dragon Slayer Excalibur');
      expect(scriptAscii).toContain('Godly');
      expect(scriptAscii).toContain('Apocalypse');
      expect(scriptAscii).toContain('monsterbattle');
    }, 30000);

    it('should estimate unlock script lengths correctly', async () => {
      const sellerWallet = await makeWallet('main', storageURL, new PrivateKey(111).toHex());
      const orderLock = new OrdLock(sellerWallet);

      // Test cancelUnlock estimate
      const cancelTemplate = orderLock.cancelUnlock({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });
      const cancelEstimate = await cancelTemplate.estimateLength();

      expect(cancelEstimate).toBe(108);
      expect(typeof cancelEstimate).toBe('number');
      expect(cancelEstimate).toBeGreaterThan(0);

      // purchaseUnlock estimate is dynamic based on transaction
      // (tested implicitly in purchase tests)
    }, 30000);
  });

  describe('Full marketplace flow', () => {
    it('should complete full cycle: mint → list → cancel → relist → purchase', async () => {
      // Three users: original minter, seller (same as minter), and buyer
      const minterPriv = new PrivateKey(112);
      const minterWallet = await makeWallet('main', storageURL, minterPriv.toHex());

      const { publicKey: minterPubKey } = await minterWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const buyerPriv = new PrivateKey(113);
      const buyerWallet = await makeWallet('main', storageURL, buyerPriv.toHex());

      const { publicKey: buyerPubKey } = await buyerWallet.getPublicKey({
        protocolID: [0, "monsterbattle"],
        keyID: "0",
        counterparty: "self",
      });

      const assetId = 'full_flow_txid_0';
      const itemData = {
        name: 'Phoenix Feather',
        type: 'material',
        rarity: 'epic',
        tier: 4
      };

      // Step 1: Deploy+Mint
      const mintTx = new Transaction();
      mintTx.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      mintTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          minterPubKey,
          assetId,
          itemData,
          'deploy+mint'
        ),
        satoshis: 1
      });

      mintTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(mintTx.id('hex'), 8000);

      // Step 2: First listing
      const minterAddress = PublicKey.fromString(minterPubKey).toAddress();
      const listing1Tx = new Transaction();

      listing1Tx.addInput({
        sourceTransaction: mintTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(minterWallet)
      });

      const orderLock = new OrdLock(minterWallet);
      const listing1Script = await orderLock.lock({
        ordAddress: minterAddress,
        payAddress: minterAddress,
        price: 3000,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listing1Tx.addOutput({
        lockingScript: listing1Script,
        satoshis: 1
      });

      await listing1Tx.fee();
      await listing1Tx.sign();

      listing1Tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(listing1Tx.id('hex'), 8001);

      // Step 3: Cancel listing
      const cancelTx = new Transaction();

      cancelTx.addInput({
        sourceTransaction: listing1Tx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: orderLock.cancelUnlock({
          protocolID: [0, "monsterbattle"],
          keyID: "0",
          counterparty: "self",
        })
      });

      cancelTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          minterPubKey,
          assetId,
          itemData,
          'transfer'
        ),
        satoshis: 1
      });

      await cancelTx.fee();
      await cancelTx.sign();

      cancelTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(cancelTx.id('hex'), 8002);

      const cancelValid = await cancelTx.verify('scripts only');
      expect(cancelValid).toBe(true);

      // Step 4: Relist at different price
      const listing2Tx = new Transaction();

      listing2Tx.addInput({
        sourceTransaction: cancelTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new OrdinalsP2PKH().unlock(minterWallet)
      });

      const listing2Script = await orderLock.lock({
        ordAddress: minterAddress,
        payAddress: minterAddress,
        price: 2500,
        assetId,
        itemData,
        metadata: { app: "monsterbattle", type: "ord" },
      });

      listing2Tx.addOutput({
        lockingScript: listing2Script,
        satoshis: 1
      });

      await listing2Tx.fee();
      await listing2Tx.sign();

      listing2Tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(listing2Tx.id('hex'), 8003);

      // Step 5: Create buyer funding UTXO (use raw private key address to match P2PKH.unlock)
      const buyerFundingAddress = buyerPriv.toPublicKey().toAddress();
      const buyerPkh = Utils.fromBase58Check(buyerFundingAddress).data as number[];
      const fundingTx = new Transaction();
      fundingTx.addInput({
        sourceTXID: '1111111111111111111111111111111111111111111111111111111111111111',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });

      fundingTx.addOutput({
        lockingScript: new P2PKH().lock(buyerPkh),
        satoshis: 3500 // Enough for payment + fees
      });

      fundingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        fundingTx.id('hex'),
        8004
      );

      // Step 6: Buyer purchases
      const purchaseTx = new Transaction();

      // Input 0: orderLock listing
      const listing2Output = listing2Tx.outputs[0];
      purchaseTx.addInput({
        sourceTransaction: listing2Tx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: orderLock.purchaseUnlock({
          sourceSatoshis: 1,
          lockingScript: listing2Output.lockingScript
        })
      });

      // Input 1: Buyer's funding
      purchaseTx.addInput({
        sourceTransaction: fundingTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(
          buyerPriv,
          'all',
          true, // anyoneCanPay = true
          fundingTx.outputs[0].satoshis,
          fundingTx.outputs[0].lockingScript
        )
      });

      purchaseTx.addOutput({
        lockingScript: new OrdinalsP2PKH().lock(
          buyerPubKey,
          assetId,
          { ...itemData, purchasedFrom: 'minter' },
          'transfer'
        ),
        satoshis: 1
      });

      const minterPkh = Utils.fromBase58Check(minterAddress).data as number[];
      purchaseTx.addOutput({
        lockingScript: new P2PKH().lock(minterPkh),
        satoshis: 2500
      });

      await purchaseTx.sign();

      const purchaseValid = await purchaseTx.verify('scripts only');
      expect(purchaseValid).toBe(true);

      // Verify buyer now owns the NFT
      const finalScript = purchaseTx.outputs[0].lockingScript.toHex();
      const finalAscii = Buffer.from(finalScript, 'hex').toString('ascii');
      expect(finalAscii).toContain(assetId);
      expect(finalAscii).toContain('purchasedFrom');
    }, 60000); // Longer timeout for full flow
  });
});

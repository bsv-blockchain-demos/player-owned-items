import { Transaction, PrivateKey, MerklePath, Script } from '@bsv/sdk';
import { OrdinalsP2PKH } from '../src/utils/ordinalP2PKH';
import { makeWallet } from './helpers/mockWallet';
import {
  TOKEN_PROTOCOL,
  generateNonce,
  deriveRecipientKey,
} from '../src/utils/tokenDerivation';

const storageURL = 'https://store-us-1.bsvb.tech';

describe('OrdinalsP2PKH derived-key unlock', () => {
  it('locks to a recipient-derived key and the recipient unlocks it (scripts valid)', async () => {
    const senderWallet = await makeWallet('main', storageURL, new PrivateKey(11).toHex());
    const recipientWallet = await makeWallet('main', storageURL, new PrivateKey(12).toHex());

    const { publicKey: senderIdentityKey } = await senderWallet.getPublicKey({ identityKey: true });
    const { publicKey: recipientIdentityKey } = await recipientWallet.getPublicKey({ identityKey: true });

    const nonce = generateNonce();

    const lockKey = await deriveRecipientKey(senderWallet, recipientIdentityKey, nonce);

    const sourceTransaction = new Transaction();
    sourceTransaction.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE'),
    });
    sourceTransaction.addOutput({
      lockingScript: new OrdinalsP2PKH().lock(lockKey, 'asset_0', { name: 'X' }, 'deploy+mint'),
      satoshis: 1,
    });
    sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(sourceTransaction.id('hex'), 1234);

    const spendingTx = new Transaction();
    spendingTx.addInput({
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new OrdinalsP2PKH().unlock(
        recipientWallet, 'all', false, undefined, undefined,
        { protocolID: TOKEN_PROTOCOL, keyID: nonce, counterparty: senderIdentityKey },
      ),
    });
    spendingTx.addOutput({
      lockingScript: new OrdinalsP2PKH().lock(lockKey, 'asset_0', { transferred: true }, 'transfer'),
      satoshis: 1,
    });

    await spendingTx.fee();
    await spendingTx.sign();
    expect(await spendingTx.verify('scripts only')).toBe(true);
  }, 30000);

  it('still verifies the legacy fixed-key path when no derivation is passed', async () => {
    const wallet = await makeWallet('main', storageURL, new PrivateKey(13).toHex());
    const { publicKey: legacyKey } = await wallet.getPublicKey({
      protocolID: [0, 'monsterbattle'], keyID: '0', counterparty: 'self',
    });

    const sourceTransaction = new Transaction();
    sourceTransaction.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE'),
    });
    sourceTransaction.addOutput({
      lockingScript: new OrdinalsP2PKH().lock(legacyKey, 'asset_0', { name: 'L' }, 'deploy+mint'),
      satoshis: 1,
    });
    sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(sourceTransaction.id('hex'), 1234);

    const spendingTx = new Transaction();
    spendingTx.addInput({
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new OrdinalsP2PKH().unlock(wallet),
    });
    spendingTx.addOutput({
      lockingScript: new OrdinalsP2PKH().lock(legacyKey, 'asset_0', { transferred: true }, 'transfer'),
      satoshis: 1,
    });

    await spendingTx.fee();
    await spendingTx.sign();
    expect(await spendingTx.verify('scripts only')).toBe(true);
  }, 30000);
});

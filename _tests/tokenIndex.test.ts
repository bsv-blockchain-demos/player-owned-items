import { recordTokenDerivation, getTokenDerivation } from '../src/lib/tokenIndex';

describe('tokenIndex', () => {
  it('records the nonce + counterparty on the matched document', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const collection = { updateOne } as any;

    await recordTokenDerivation(collection, { tokenId: 'txid.0' }, { keyId: 'N', counterparty: 'S' });

    expect(updateOne).toHaveBeenCalledWith(
      { tokenId: 'txid.0' },
      { $set: { keyId: 'N', counterparty: 'S' } },
    );
  });

  it('reads back a stored derivation', async () => {
    const findOne = jest.fn().mockResolvedValue({ tokenId: 'txid.0', keyId: 'N', counterparty: 'S' });
    const collection = { findOne } as any;

    expect(await getTokenDerivation(collection, 'txid.0')).toEqual({ keyId: 'N', counterparty: 'S' });
  });

  it('returns null for a legacy token with no nonce', async () => {
    const findOne = jest.fn().mockResolvedValue({ tokenId: 'txid.0' }); // no keyId
    const collection = { findOne } as any;

    expect(await getTokenDerivation(collection, 'txid.0')).toBeNull();
  });
});

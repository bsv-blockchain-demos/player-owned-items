// _tests/reindexFromBasket.test.ts
import { reindexFromBasket } from '../src/utils/reindexFromBasket';
import { TOKEN_BASKET } from '../src/utils/internalizeToBasket';

describe('reindexFromBasket', () => {
  it('maps listOutputs results into index records using customInstructions', async () => {
    const listOutputs = jest.fn().mockResolvedValue({
      totalOutputs: 1,
      outputs: [{
        outpoint: 'txid.0',
        satoshis: 1,
        tags: ['type:item'],
        customInstructions: JSON.stringify({ keyId: 'N', counterparty: 'S' }),
      }],
    });
    const wallet = { listOutputs } as any;

    const result = await reindexFromBasket(wallet, ['type:item']);

    expect(listOutputs).toHaveBeenCalledWith({
      basket: TOKEN_BASKET,
      tags: ['type:item'],
      includeCustomInstructions: true,
    });
    expect(result).toEqual([
      { outpoint: 'txid.0', satoshis: 1, keyId: 'N', counterparty: 'S', tags: ['type:item'] },
    ]);
  });
});

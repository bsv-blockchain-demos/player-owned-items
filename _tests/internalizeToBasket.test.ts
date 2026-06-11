// _tests/internalizeToBasket.test.ts
import { internalizeToBasket, TOKEN_BASKET } from '../src/utils/internalizeToBasket';

describe('internalizeToBasket', () => {
  it('calls internalizeAction with basket insertion + nonce in customInstructions', async () => {
    const internalizeAction = jest.fn().mockResolvedValue({ accepted: true });
    const wallet = { internalizeAction } as any;

    await internalizeToBasket(
      wallet,
      [1, 2, 3],
      [{ outputIndex: 0, keyId: 'NONCE', counterparty: 'SERVERKEY', tags: ['type:item'] }],
      'Receive minted item',
    );

    expect(internalizeAction).toHaveBeenCalledTimes(1);
    const arg = internalizeAction.mock.calls[0][0];
    expect(arg.tx).toEqual([1, 2, 3]);
    expect(arg.outputs[0].protocol).toBe('basket insertion');
    expect(arg.outputs[0].insertionRemittance.basket).toBe(TOKEN_BASKET);
    expect(arg.outputs[0].insertionRemittance.tags).toEqual(['type:item']);
    const ci = JSON.parse(arg.outputs[0].insertionRemittance.customInstructions);
    expect(ci.keyId).toBe('NONCE');
    expect(ci.counterparty).toBe('SERVERKEY');
  });
});

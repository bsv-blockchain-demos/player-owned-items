// _tests/tokenDerivation.test.ts
import { generateNonce, TOKEN_PROTOCOL } from '../src/utils/tokenDerivation';
import { Utils } from '@bsv/sdk';

describe('tokenDerivation', () => {
  it('TOKEN_PROTOCOL is security level 2 (counterparty-bound)', () => {
    expect(TOKEN_PROTOCOL[0]).toBe(2);
  });

  it('generateNonce returns distinct base64 values decoding to 16 bytes', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toEqual(b);
    expect(Utils.toArray(a, 'base64').length).toBe(16);
  });
});

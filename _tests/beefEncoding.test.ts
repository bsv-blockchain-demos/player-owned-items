import { encodeBeef, decodeBeef } from '../src/utils/beefEncoding';

describe('beefEncoding', () => {
  it('round-trips a byte array through base64', () => {
    const bytes = [0, 1, 2, 254, 255, 128, 7, 42];
    const encoded = encodeBeef(bytes);
    expect(typeof encoded).toBe('string');
    expect(decodeBeef(encoded)).toEqual(bytes);
  });

  it('produces a shorter string than JSON.stringify of the array', () => {
    const bytes = Array.from({ length: 500 }, (_, i) => i % 256);
    expect(encodeBeef(bytes).length).toBeLessThan(JSON.stringify(bytes).length);
  });
});

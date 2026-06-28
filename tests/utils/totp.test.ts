import { describe, expect, it } from 'vitest';
import { generateTotpCode } from '../../src/utils/totp.js';

const RFC_6238_SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('generateTotpCode', () => {
  it('matches RFC 6238 SHA1 test vectors', () => {
    const vectors = [
      { timestampSeconds: 59, code: '94287082' },
      { timestampSeconds: 1_111_111_109, code: '07081804' },
      { timestampSeconds: 1_111_111_111, code: '14050471' },
      { timestampSeconds: 1_234_567_890, code: '89005924' },
      { timestampSeconds: 2_000_000_000, code: '69279037' },
      { timestampSeconds: 20_000_000_000, code: '65353130' },
    ];

    for (const vector of vectors) {
      expect(
        generateTotpCode(RFC_6238_SHA1_SECRET, {
          timestampMs: vector.timestampSeconds * 1000,
          digits: 8,
        }),
      ).toBe(vector.code);
    }
  });

  it('defaults to 6 digits and 30 second windows', () => {
    expect(generateTotpCode(RFC_6238_SHA1_SECRET, { timestampMs: 59_000 })).toBe('287082');
  });

  it('accepts lowercase Base32 secrets with spaces and padding', () => {
    const secret = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq====';
    expect(generateTotpCode(secret, { timestampMs: 59_000, digits: 8 })).toBe('94287082');
  });

  it('rejects invalid Base32 secrets', () => {
    expect(() => generateTotpCode('bad-secret-$')).toThrow('Base32');
  });

  it('rejects empty Base32 secrets', () => {
    expect(() => generateTotpCode('   ')).toThrow('must not be empty');
  });
});

/**
 * Minimal RFC 6238 TOTP helper for DSM 2FA login.
 */

import { createHmac } from 'node:crypto';

interface TotpOptions {
  /** Unix timestamp in milliseconds; defaults to Date.now(). */
  timestampMs?: number;
  /** TOTP time step in seconds. */
  stepSeconds?: number;
  /** Number of digits in the generated code. */
  digits?: number;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Generates a TOTP code from a Base32 secret using Synology-compatible
 * defaults: HMAC-SHA1, 30 second time step, 6 digits.
 */
export function generateTotpCode(secret: string, options: TotpOptions = {}): string {
  const stepSeconds = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const timestampMs = options.timestampMs ?? Date.now();

  if (!Number.isInteger(stepSeconds) || stepSeconds <= 0) {
    throw new Error('TOTP stepSeconds must be a positive integer');
  }
  if (!Number.isInteger(digits) || digits <= 0 || digits > 10) {
    throw new Error('TOTP digits must be an integer between 1 and 10');
  }

  const key = decodeBase32(secret);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = getDigestByte(digest, digest.length - 1) & 0x0f;
  const binary =
    ((getDigestByte(digest, offset) & 0x7f) << 24) |
    ((getDigestByte(digest, offset + 1) & 0xff) << 16) |
    ((getDigestByte(digest, offset + 2) & 0xff) << 8) |
    (getDigestByte(digest, offset + 3) & 0xff);

  const modulo = 10 ** digits;
  return String(binary % modulo).padStart(digits, '0');
}

function decodeBase32(secret: string): Buffer {
  const normalized = secret.toUpperCase().replace(/[\s=]/g, '');
  if (normalized.length === 0) {
    throw new Error('TOTP secret must not be empty');
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('TOTP secret must be Base32 using A-Z and 2-7');
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (bytes.length === 0) {
    throw new Error('TOTP secret did not contain enough Base32 data');
  }

  return Buffer.from(bytes);
}

function getDigestByte(digest: Buffer, index: number): number {
  const byte = digest[index];
  if (byte === undefined) {
    throw new Error('TOTP digest offset out of range');
  }
  return byte;
}

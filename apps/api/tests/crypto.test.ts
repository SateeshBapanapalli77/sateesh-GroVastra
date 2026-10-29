import { describe, it, expect } from 'vitest';
import {
  normalizePhoneNumber,
  destinationHash,
  encryptPhone,
  decryptPhone,
  maskPhone,
} from '../src/utils/crypto';

describe('Crypto & Destination Helpers (Hard Rules 8 & 9, Spec p18, p25)', () => {
  const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  describe('normalizePhoneNumber', () => {
    it('normalizes 10-digit Indian numbers to international digits-only format', () => {
      expect(normalizePhoneNumber('9876543210')).toBe('919876543210');
      expect(normalizePhoneNumber(' 98765 43210 ')).toBe('919876543210');
    });

    it('removes + prefix, dashes, spaces and formatting', () => {
      expect(normalizePhoneNumber('+91 99999-99999')).toBe('919999999999');
      expect(normalizePhoneNumber('+91 (987) 654-3210')).toBe('919876543210');
    });

    it('strips leading zeroes before country prefix', () => {
      expect(normalizePhoneNumber('09876543210')).toBe('919876543210');
    });

    it('throws error for invalid or short phone numbers', () => {
      expect(() => normalizePhoneNumber('123')).toThrow();
      expect(() => normalizePhoneNumber('')).toThrow();
    });
  });

  describe('destinationHash (HMAC-SHA256)', () => {
    it('produces deterministic 64-character lowercase hex hash', () => {
      const hash1 = destinationHash('+91 99999 99999', TEST_KEY);
      const hash2 = destinationHash('919999999999', TEST_KEY);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different hashes for different numbers', () => {
      const hash1 = destinationHash('+91 99999 99999', TEST_KEY);
      const hash2 = destinationHash('+91 98888 88888', TEST_KEY);

      expect(hash1).not.toBe(hash2);
    });

    it('produces different hashes for different keys', () => {
      const OTHER_KEY = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const hash1 = destinationHash('+91 99999 99999', TEST_KEY);
      const hash2 = destinationHash('+91 99999 99999', OTHER_KEY);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('encryptPhone & decryptPhone (AES-256-GCM Round-trip)', () => {
    it('encrypts and decrypts phone numbers accurately', () => {
      const original = '+91 98765 43210';
      const encrypted = encryptPhone(original, TEST_KEY);

      expect(encrypted).toContain(':');
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3); // iv, tag, ciphertext
      expect(parts[0]).toHaveLength(24); // 12-byte IV in hex = 24 chars
      expect(parts[1]).toHaveLength(32); // 16-byte auth tag in hex = 32 chars

      const decrypted = decryptPhone(encrypted, TEST_KEY);
      expect(decrypted).toBe('919876543210');
    });

    it('produces different ciphertexts for identical numbers due to random IVs', () => {
      const phone = '+91 99999 99999';
      const enc1 = encryptPhone(phone, TEST_KEY);
      const enc2 = encryptPhone(phone, TEST_KEY);

      expect(enc1).not.toBe(enc2);
      expect(decryptPhone(enc1, TEST_KEY)).toBe(decryptPhone(enc2, TEST_KEY));
    });

    it('fails decryption with corrupted ciphertext or auth tag (tamper detection)', () => {
      const encrypted = encryptPhone('+91 98765 43210', TEST_KEY);
      const [iv, tag, cipher] = encrypted.split(':');

      // Tamper with ciphertext
      const tamperedCipher = cipher.slice(0, -2) + (cipher.slice(-2) === 'aa' ? 'bb' : 'aa');
      const tamperedData = `${iv}:${tag}:${tamperedCipher}`;

      expect(() => decryptPhone(tamperedData, TEST_KEY)).toThrow();
    });

    it('fails decryption with incorrect key', () => {
      const OTHER_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const encrypted = encryptPhone('+91 98765 43210', TEST_KEY);

      expect(() => decryptPhone(encrypted, OTHER_KEY)).toThrow();
    });
  });

  describe('maskPhone', () => {
    it('masks phone numbers safely for UI and logs', () => {
      const masked = maskPhone('919876543210');
      expect(masked).toBe('+91 98*** **210');
      expect(masked).not.toContain('76543');
    });
  });
});

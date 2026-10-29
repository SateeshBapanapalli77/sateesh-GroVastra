import crypto from 'crypto';
import { config } from '../config/env';
import { maskPhoneNumber } from '@grovastra/shared';

/**
 * Normalizes phone numbers to digits-only international format (no plus sign).
 * Example: "+91 99999 99999" -> "919999999999"
 * Example: "9876543210" (10-digit Indian) -> "919876543210"
 * Example: "+1 (555) 234-5678" -> "15552345678"
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Invalid phone number: must be a non-empty string');
  }

  // Strip all non-digit characters
  let digits = phone.replace(/\D/g, '');

  // If leading zero (e.g., 09876543210), strip it
  if (digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '');
  }

  // If 10 digits (standard Indian mobile without country code), default prefix to 91
  if (digits.length === 10) {
    digits = `91${digits}`;
  }

  if (digits.length < 8 || digits.length > 15) {
    throw new Error(`Invalid phone length (${digits.length} digits): ${phone}`);
  }

  return digits;
}

/**
 * Computes deterministic destinationHash (HMAC-SHA256) of the normalized phone number.
 * Required for contact reservation, collision prevention, and indexing without leaking plain numbers.
 */
export function destinationHash(phone: string, keyHex?: string): string {
  const normalized = normalizePhoneNumber(phone);
  const activeKey = keyHex || config.ENCRYPTION_KEY;

  if (!activeKey || activeKey.length !== 64) {
    throw new Error('destinationHash requires a valid 32-byte (64-character hex) key');
  }

  const keyBuffer = Buffer.from(activeKey, 'hex');
  return crypto.createHmac('sha256', keyBuffer).update(normalized, 'utf8').digest('hex');
}

/**
 * Encrypts a phone number using AES-256-GCM with a random 12-byte IV.
 * Format: "<iv_hex>:<auth_tag_hex>:<ciphertext_hex>"
 */
export function encryptPhone(phone: string, keyHex?: string): string {
  const normalized = normalizePhoneNumber(phone);
  const activeKey = keyHex || config.ENCRYPTION_KEY;

  if (!activeKey || activeKey.length !== 64) {
    throw new Error('encryptPhone requires a valid 32-byte (64-character hex) key');
  }

  const keyBuffer = Buffer.from(activeKey, 'hex');
  const iv = crypto.randomBytes(12); // 96-bit standard IV for GCM

  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts a phone number encrypted with encryptPhone.
 */
export function decryptPhone(encryptedPhone: string, keyHex?: string): string {
  if (!encryptedPhone || typeof encryptedPhone !== 'string') {
    throw new Error('decryptPhone requires a valid non-empty string');
  }

  const parts = encryptedPhone.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted phone format: expected "<iv>:<tag>:<ciphertext>"');
  }

  const [ivHex, tagHex, cipherHex] = parts;
  const activeKey = keyHex || config.ENCRYPTION_KEY;

  if (!activeKey || activeKey.length !== 64) {
    throw new Error('decryptPhone requires a valid 32-byte (64-character hex) key');
  }

  const keyBuffer = Buffer.from(activeKey, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Formats a phone number for safe UI display and logs.
 * Example: "919999999999" -> "+91 99*** **999"
 */
export function maskPhone(phone: string): string {
  if (!phone) return '';
  const normalized = phone.replace(/\D/g, '');
  if (normalized.length === 12 && normalized.startsWith('91')) {
    // Standard Indian international format
    const cc = '+91';
    const firstTwo = normalized.slice(2, 4);
    const lastThree = normalized.slice(-3);
    return `${cc} ${firstTwo}*** **${lastThree}`;
  }
  return maskPhoneNumber(phone);
}

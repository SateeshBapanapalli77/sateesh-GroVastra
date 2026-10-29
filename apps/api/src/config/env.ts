import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from workspace root or current directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  
  // MongoDB Configuration
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required').default('mongodb://localhost:27017/?replicaSet=rs0'),
  MONGODB_DB: z.string().min(1, 'MONGODB_DB is required').default('grovastra_dev'),
  MONGODB_TEST_DB: z.string().min(1, 'MONGODB_TEST_DB is required').default('grovastra_test'),

  // Campaign Dispatch Mode
  DISPATCH_MODE: z.enum(['dry', 'meta']).default('dry'),
  ALLOW_TEST_CATEGORY_MISMATCH: z
    .preprocess((val) => val === 'true' || val === true || val === '1', z.boolean())
    .default(false),

  // Meta WhatsApp Cloud API (Optional for skeleton / dry run)
  META_ACCESS_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_TEST_ALLOWLIST: z.string().optional(),
  LIVE_CUSTOMER_PHONES: z.string().optional(),

  // Encryption & Auth Secrets
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters long'),

  // Dev Clock Offset (in ms)
  DEV_TIME_OFFSET_MS: z.coerce.number().int().default(0),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadConfig(envInput: Record<string, unknown> = process.env): EnvConfig {
  const isTest = envInput.NODE_ENV === 'test' || process.env.NODE_ENV === 'test';

  if (!envInput.ENCRYPTION_KEY && !isTest) {
    const psCommand = `powershell -Command "-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Minimum 0 -Maximum 256) })"`;
    const fatalMsg = [
      '================================================================================',
      '[FATAL CONFIG ERROR] ENCRYPTION_KEY is missing in .env!',
      'To generate a secure 32-byte ENCRYPTION_KEY, run this PowerShell command:',
      `  ${psCommand}`,
      'Then add the generated 64-character hex string to your .env file:',
      '  ENCRYPTION_KEY=<generated_key>',
      'SECURITY RULE: Never write secrets to tracked files.',
      '================================================================================',
    ].join('\n');

    console.error(fatalMsg);
    throw new Error(fatalMsg);
  }

  if (!envInput.SESSION_SECRET && !isTest) {
    const psCommand = `powershell -Command "[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))"`;
    const fatalMsg = [
      '================================================================================',
      '[FATAL CONFIG ERROR] SESSION_SECRET is missing in .env!',
      'To generate a secure SESSION_SECRET, run this PowerShell command:',
      `  ${psCommand}`,
      'Then add the generated string to your .env file:',
      '  SESSION_SECRET=<generated_secret>',
      'SECURITY RULE: Never write secrets to tracked files.',
      '================================================================================',
    ].join('\n');

    console.error(fatalMsg);
    throw new Error(fatalMsg);
  }

  const sanitizedInput = {
    ...envInput,
    ENCRYPTION_KEY:
      (envInput.ENCRYPTION_KEY as string) ||
      (isTest ? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' : undefined),
    SESSION_SECRET:
      (envInput.SESSION_SECRET as string) ||
      (isTest ? 'test-session-secret-at-least-32-chars-long' : undefined),
  };

  const result = EnvSchema.safeParse(sanitizedInput);
  
  if (!result.success) {
    const errorDetails = result.error.errors.map((err) => {
      const field = err.path.join('.');
      return `  - ${field}: ${err.message}`;
    }).join('\n');

    const formattedMessage = [
      '================================================================================',
      '[CONFIG VALIDATION ERROR] Invalid environment configuration:',
      errorDetails,
      'Please check your .env file and ensure required variables are set correctly.',
      '================================================================================',
    ].join('\n');

    console.error(formattedMessage);
    throw new Error(formattedMessage);
  }

  return result.data;
}

export const config = loadConfig();


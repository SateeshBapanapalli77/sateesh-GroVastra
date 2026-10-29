import pino from 'pino';
import { config } from '../config/env';

export const REDACTED_PATHS = [
  // Sensitive tokens and secrets
  'token',
  'accessToken',
  'META_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
  'secret',
  'password',
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'cookie',
  'headers.cookie',
  'req.headers.cookie',

  // Phone numbers (Hard Rule 9)
  'phone',
  'phoneNumber',
  'customerPhone',
  'to',
  'from',
  'destination',
  'recipient',
  'body.phone',
  'body.phoneNumber',
  'body.to',
  'body.from',
  '*.phone',
  '*.phoneNumber',
  '*.customerPhone',
  '*.to',
  '*.from',
  '*.destination',
  '*.recipient',

  // Message bodies and template parameters (Hard Rule 9)
  'messageBody',
  'message',
  'text.body',
  'templateParameters',
  'body.messageBody',
  'body.message',
  'body.text.body',
  'body.templateParameters',
  '*.messageBody',
  '*.templateParameters',
];

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: {
    paths: REDACTED_PATHS,
    censor: '[REDACTED]',
  },
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          },
        }
      : undefined,
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

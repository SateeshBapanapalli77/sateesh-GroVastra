import express, { Request, Response, Router } from 'express';
import { config } from '../config/env';
import { logger } from '../logger';
import { verifyMetaSignature, webhookService } from '../services/webhook/webhook.service';

export const webhookRouter = Router();

/**
 * GET /webhooks/whatsapp & GET /api/v1/webhooks/whatsapp
 * Meta WhatsApp Cloud API Webhook Verification Challenge [M2].
 * Meta sends hub.mode, hub.challenge, and hub.verify_token as query parameters.
 */
function webhookVerificationHandler(req: Request, res: Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN || config.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
    logger.info('Meta webhook challenge verification succeeded.');
    return res.status(200).send(challenge);
  }

  logger.warn({ mode, tokenReceived: !!token }, 'Meta webhook verification failed: invalid mode or token.');
  return res.status(403).send('Forbidden');
}

/**
 * POST /webhooks/whatsapp & POST /api/v1/webhooks/whatsapp
 * Meta WhatsApp Cloud API Webhook Ingestion [M2, M3].
 * Verifies X-Hub-Signature-256 over raw request byte buffer with META_APP_SECRET before parsing (C11).
 */
async function webhookPostHandler(req: Request, res: Response) {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    logger.error('Webhook payload is not a raw buffer. Signature cannot be verified before parsing.');
    return res.status(400).json({ error: 'Expected raw request body' });
  }

  const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;

  // 1. Verify X-Hub-Signature-256 BEFORE parsing JSON (Hard Rule C11)
  const isValid = verifyMetaSignature(rawBody, signatureHeader);
  if (!isValid) {
    logger.warn({ signatureHeader: signatureHeader ? 'present' : 'missing' }, 'Rejecting forged webhook request (C11).');
    return res.status(401).json({ error: 'Invalid or missing X-Hub-Signature-256' });
  }

  // 2. Parse JSON only after successful signature verification
  let parsedPayload: any;
  try {
    parsedPayload = JSON.parse(rawBody.toString('utf8'));
  } catch (err: any) {
    logger.error({ error: err?.message }, 'Failed to parse verified webhook payload as JSON.');
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }

  // 3. Process delivery statuses and customer replies
  try {
    const result = await webhookService.processWebhookPayload(parsedPayload);
    logger.info(result, 'Webhook payload processed successfully.');
    return res.status(200).json({ success: true, ...result });
  } catch (err: any) {
    logger.error({ error: err?.message, stack: err?.stack }, 'Error processing webhook payload.');
    // Return 200 to provider per Meta guidelines to prevent webhook retry storms on unhandled errors,
    // after logging internal error
    return res.status(200).json({ success: false, error: err?.message });
  }
}

// Raw body parser middleware specifically for webhook POST routes
const rawBodyParser = express.raw({ type: '*/*', limit: '10mb' });

// Mount GET verification endpoints
webhookRouter.get('/webhooks/whatsapp', webhookVerificationHandler);
webhookRouter.get('/api/v1/webhooks/whatsapp', webhookVerificationHandler);

// Mount POST ingestion endpoints with raw byte parsing
webhookRouter.post('/webhooks/whatsapp', rawBodyParser, webhookPostHandler);
webhookRouter.post('/api/v1/webhooks/whatsapp', rawBodyParser, webhookPostHandler);

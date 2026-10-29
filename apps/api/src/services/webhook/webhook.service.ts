import crypto from 'crypto';
import {
  EXECUTION_STATE,
  ExecutionState,
  DELIVERY_INTENT_STATE,
} from '@grovastra/shared';
import {
  SrcConnectionModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignEnrollmentModel,
  CampaignProviderEventModel,
  ICampaignExecution,
  ICampaignEnrollment,
} from '../../db/models';
import { mockCustomerSource } from '../../adapters';
import { config } from '../../config/env';
import { logger } from '../../logger';
import { destinationHash, maskPhone, normalizePhoneNumber } from '../../utils/crypto';
import { contactGateService } from '../contact-gate/contact-gate.service';
import { SrcCustomerModel } from '../../db/models/src-customer.model';

export interface ProcessWebhookResult {
  processedStatuses: number;
  processedInbound: number;
  duplicateCount: number;
  eventsRecorded: number;
}

/**
 * Status hierarchy ranks for monotonic progression (Spec p27):
 * Late sent cannot overwrite delivered/read.
 * Delivered cannot overwrite read.
 */
const STATUS_RANKS: Record<string, number> = {
  DISPATCHING: 1,
  EVALUATING: 1,
  OUTCOME_UNKNOWN: 1,
  PROVIDER_ACCEPTED: 1,
  sent: 2,
  SENT: 2,
  delivered: 3,
  DELIVERED: 3,
  read: 4,
  READ: 4,
};

/**
 * Verifies the X-Hub-Signature-256 header against the raw request byte buffer using META_APP_SECRET.
 * Adheres to Meta Graph API webhook signature verification specification [M3].
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader?: string,
  appSecret?: string
): boolean {
  const secret = appSecret || process.env.META_APP_SECRET || config.META_APP_SECRET;
  if (!secret) {
    logger.warn('verifyMetaSignature: META_APP_SECRET is not configured.');
    return false;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const providedHash = signatureHeader.substring('sha256='.length).trim();
  const expectedHash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const providedBuffer = Buffer.from(providedHash, 'utf8');
  const expectedBuffer = Buffer.from(expectedHash, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Recursively sanitizes raw payloads before storing:
 * Masks phone numbers and redacts customer message text bodies (Hard Rule 9, Spec p21).
 */
export function sanitizePayload(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === 'string') {
    // If string looks like a 10-15 digit phone number, mask it
    if (/^\+?\d{10,15}$/.test(obj.trim())) {
      return maskPhone(obj.trim());
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizePayload(item));
  }
  if (typeof obj === 'object') {
    const sanitized: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (['recipient_id', 'from', 'wa_id', 'display_phone_number'].includes(key) && typeof val === 'string') {
        sanitized[key] = maskPhone(val);
      } else if (key === 'text' && typeof val === 'object' && val !== null && 'body' in val) {
        // Redact customer message text bodies per Hard Rule 9
        sanitized[key] = { ...val, body: '[REDACTED]' };
      } else {
        sanitized[key] = sanitizePayload(val);
      }
    }
    return sanitized;
  }
  return obj;
}

export class WebhookService {
  /**
   * Processes a verified Meta WhatsApp Cloud API webhook payload.
   * Durably records events in campaignProviderEvents before acknowledging (C10, C12).
   */
  async processWebhookPayload(payload: any): Promise<ProcessWebhookResult> {
    let processedStatuses = 0;
    let processedInbound = 0;
    let duplicateCount = 0;
    let eventsRecorded = 0;

    if (!payload || !Array.isArray(payload.entry)) {
      return { processedStatuses, processedInbound, duplicateCount, eventsRecorded };
    }

    for (const entry of payload.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        const val = change.value;
        if (!val) continue;

        const phoneNumberId = val.metadata?.phone_number_id;
        if (!phoneNumberId) {
          logger.warn('Webhook change missing metadata.phone_number_id');
          continue;
        }

        // Map connection strictly by phone_number_id (Spec p27)
        const connection: any = await SrcConnectionModel.findOne({ phoneNumberId }).lean();
        if (!connection) {
          logger.warn(
            { phoneNumberId },
            'Webhook received for unknown connection. Ignoring safely (C11).'
          );
          continue;
        }

        const tenantId = connection.tenantId;

        // -------------------------------------------------------------------
        // 1. PROCESS OUTBOUND DELIVERY STATUSES (sent | delivered | read | failed)
        // -------------------------------------------------------------------
        if (Array.isArray(val.statuses)) {
          for (const statusItem of val.statuses) {
            const status = statusItem.status; // 'sent' | 'delivered' | 'read' | 'failed'
            const messageId = statusItem.id; // wamid
            const timestampSec = String(statusItem.timestamp || '');
            const rawRecipient = String(statusItem.recipient_id || '');

            if (!status || !messageId || !timestampSec) {
              continue;
            }

            const eventTimestamp = new Date(parseInt(timestampSec, 10) * 1000);
            let destHash: string | null = null;
            let maskedRecipient: string | null = null;

            try {
              if (rawRecipient) {
                const normalizedRecipient = normalizePhoneNumber(rawRecipient);
                destHash = destinationHash(normalizedRecipient);
                maskedRecipient = maskPhone(normalizedRecipient);
              }
            } catch {
              // Ignore recipient formatting errors
            }

            // Dedupe per status event (message id + status + timestamp), not just message id (C10)
            const dedupeKey = `${tenantId}:${messageId}:${status}:${timestampSec}`;
            const existingEvent = await CampaignProviderEventModel.findOne({
              tenantId,
              dedupeKey,
            }).lean();

            if (existingEvent) {
              logger.info(
                { dedupeKey, status, messageId },
                'Webhook status event already processed. Skipping duplicate (C10 replay safety).'
              );
              duplicateCount++;
              continue;
            }

            // -----------------------------------------------------------------
            // Correlate with Execution (C12: including before response persistence)
            // -----------------------------------------------------------------
            let execution: ICampaignExecution | null = await CampaignExecutionModel.findOne({
              tenantId,
              providerMessageId: messageId,
            });

            // If not found by messageId (e.g. C12: event arrived before HTTP response was saved or timeout):
            if (!execution && destHash) {
              const customer = await mockCustomerSource.getCustomerByDestinationHash(tenantId, destHash);
              if (customer) {
                const activeEnrollments = await CampaignEnrollmentModel.find({
                  tenantId,
                  customerId: customer.customerId,
                  status: 'ACTIVE',
                }).lean();
                const activeEnrollmentIds = activeEnrollments.map((e) => e.enrollmentId);

                if (activeEnrollmentIds.length > 0) {
                  // Find recent execution in-flight or waiting for response
                  execution = await CampaignExecutionModel.findOne({
                    tenantId,
                    enrollmentId: { $in: activeEnrollmentIds },
                    state: {
                      $in: [
                        EXECUTION_STATE.DISPATCHING,
                        EXECUTION_STATE.EVALUATING,
                        EXECUTION_STATE.OUTCOME_UNKNOWN,
                        EXECUTION_STATE.PROVIDER_ACCEPTED,
                      ],
                    },
                  }).sort({ updatedAt: -1 });

                  if (execution) {
                    logger.info(
                      {
                        executionId: execution.executionId,
                        messageId,
                        status,
                      },
                      'Correlated status event arriving before response persistence to original attempt (C12).'
                    );
                    execution.providerMessageId = messageId;
                  }
                }
              }
            }

            // -----------------------------------------------------------------
            // Durably store event BEFORE updating states or acknowledging (Spec p27)
            // -----------------------------------------------------------------
            await CampaignProviderEventModel.create({
              eventId: `cpe_${crypto.randomUUID()}`,
              tenantId,
              phoneNumberId,
              eventType: 'STATUS',
              messageId,
              status,
              timestamp: eventTimestamp,
              recipientHash: destHash,
              recipientMasked: maskedRecipient,
              dedupeKey,
              rawPayload: sanitizePayload(statusItem),
              correlatedExecutionId: execution?.executionId || null,
              correlatedEnrollmentId: execution?.enrollmentId || null,
              processed: true,
            });
            eventsRecorded++;
            processedStatuses++;

            // -----------------------------------------------------------------
            // Monotonic Status Projection onto Execution & Delivery Intent
            // -----------------------------------------------------------------
            if (execution) {
              const currentRank = STATUS_RANKS[execution.state] || 0;
              const updateExecutionFields: Record<string, any> = {
                providerMessageId: messageId,
                providerStatus: status,
              };
              const updateIntentFields: Record<string, any> = {
                providerMessageId: messageId,
              };

              if (status === 'sent') {
                if (!execution.sentAt) {
                  updateExecutionFields.sentAt = eventTimestamp;
                }
                // Late 'sent' must not overwrite delivered or read (Spec p27)
                if (currentRank < 2) {
                  updateExecutionFields.state = EXECUTION_STATE.SENT;
                  updateIntentFields.state = DELIVERY_INTENT_STATE.SENT;
                }
              } else if (status === 'delivered') {
                if (!execution.deliveredAt) {
                  updateExecutionFields.deliveredAt = eventTimestamp;
                }
                // Delivered must not overwrite read (Spec p27)
                if (currentRank < 3) {
                  updateExecutionFields.state = EXECUTION_STATE.DELIVERED;
                  updateIntentFields.state = DELIVERY_INTENT_STATE.DELIVERED;
                }
              } else if (status === 'read') {
                if (!execution.readAt) {
                  updateExecutionFields.readAt = eventTimestamp;
                }
                // Spec p27: A read event implies delivery without supplying an exact earlier delivery timestamp!
                if (currentRank < 4) {
                  updateExecutionFields.state = EXECUTION_STATE.READ;
                  updateIntentFields.state = DELIVERY_INTENT_STATE.READ;
                }
              } else if (status === 'failed') {
                const primaryError = statusItem.errors?.[0];
                const errorCode = Number(primaryError?.code);
                const isUndeliverable = errorCode === 131026;

                // If message failed at provider, only update to failed if not already delivered/read
                if (currentRank < 3) {
                  updateExecutionFields.state = EXECUTION_STATE.FAILED;
                  updateExecutionFields.lastErrorCategory = isUndeliverable ? 'DESTINATION_UNDELIVERABLE' : 'PROVIDER_FAILED';
                  const errorMsg = isUndeliverable ? 'DESTINATION_UNDELIVERABLE' : (primaryError?.message || 'WhatsApp Cloud API delivery failure');
                  updateExecutionFields.skipReason = errorMsg;

                  updateIntentFields.state = DELIVERY_INTENT_STATE.FAILED;
                  updateIntentFields.lastErrorCategory = isUndeliverable ? 'DESTINATION_UNDELIVERABLE' : 'PROVIDER_FAILED';
                }
                if (!execution.failedAt) {
                  updateExecutionFields.failedAt = eventTimestamp;
                }

                if (isUndeliverable && destHash) {
                  await contactGateService.markUndeliverable(
                    tenantId,
                    destHash,
                    'RECIPIENT_NOT_ON_WHATSAPP (131026)',
                    'PROVIDER_STATUS'
                  );
                }
              }

              // Persist monotonic projection and append to statusHistory
              await Promise.all([
                CampaignExecutionModel.updateOne(
                  { tenantId, executionId: execution.executionId },
                  {
                    $set: updateExecutionFields,
                    $push: {
                      statusHistory: {
                        status,
                        timestamp: eventTimestamp,
                        providerMessageId: messageId,
                      },
                    },
                  }
                ),
                CampaignDeliveryIntentModel.updateOne(
                  { tenantId, executionId: execution.executionId },
                  { $set: updateIntentFields }
                ),
              ]);
            } else if (status === 'failed') {
              // Even without matching execution, mark destination health if error 131026
              const primaryError = statusItem.errors?.[0];
              const errorCode = Number(primaryError?.code);
              const isUndeliverable = errorCode === 131026;
              if (isUndeliverable && destHash) {
                await contactGateService.markUndeliverable(
                  tenantId,
                  destHash,
                  'RECIPIENT_NOT_ON_WHATSAPP (131026)',
                  'PROVIDER_STATUS'
                );
              }
            }
          }
        }

        // -------------------------------------------------------------------
        // 2. PROCESS INBOUND CUSTOMER REPLIES (value.messages[])
        // -------------------------------------------------------------------
        if (Array.isArray(val.messages)) {
          for (const messageItem of val.messages) {
            const fromRaw = String(messageItem.from || '');
            const messageId = messageItem.id;
            const timestampSec = String(messageItem.timestamp || '');

            if (!fromRaw || !messageId || !timestampSec) {
              continue;
            }

            const messageTimestamp = new Date(parseInt(timestampSec, 10) * 1000);
            let destHash: string | null = null;
            let maskedFrom: string | null = null;

            try {
              const normalizedFrom = normalizePhoneNumber(fromRaw);
              destHash = destinationHash(normalizedFrom);
              maskedFrom = maskPhone(normalizedFrom);
            } catch {
              // Ignore phone normalization errors
            }

            // Deduplication per inbound message
            const dedupeKey = `${tenantId}:inbound:${messageId}`;
            const existingInbound = await CampaignProviderEventModel.findOne({
              tenantId,
              dedupeKey,
            }).lean();

            if (existingInbound) {
              logger.info({ dedupeKey, messageId }, 'Inbound reply already processed. Skipping duplicate.');
              duplicateCount++;
              continue;
            }

            // Customer directory lookup by destinationHash
            const customer = destHash
              ? await mockCustomerSource.getCustomerByDestinationHash(tenantId, destHash)
              : null;

            // Context check: does context.id point to one of our campaign executions?
            const contextId = messageItem.context?.id;
            let matchedExecution: ICampaignExecution | null = null;
            let matchedEnrollment: ICampaignEnrollment | null = null;
            let replyAttribution: 'CAMPAIGN' | 'NOT_CAMPAIGN_CONSERVATIVE' = 'NOT_CAMPAIGN_CONSERVATIVE';

            if (contextId) {
              matchedExecution = await CampaignExecutionModel.findOne({
                tenantId,
                providerMessageId: contextId,
              });

              if (matchedExecution) {
                matchedEnrollment = await CampaignEnrollmentModel.findOne({
                  tenantId,
                  enrollmentId: matchedExecution.enrollmentId,
                });
                replyAttribution = 'CAMPAIGN';
              }
            }

            if (matchedEnrollment) {
              // Exact context match: mark that specific enrollment's reply
              logger.info(
                {
                  enrollmentId: matchedEnrollment.enrollmentId,
                  contextId,
                  messageId,
                },
                'Inbound reply matched exact campaign context: applying replyHoldAt (CAMPAIGN attribution).'
              );

              await CampaignEnrollmentModel.updateOne(
                { tenantId, enrollmentId: matchedEnrollment.enrollmentId },
                {
                  $set: {
                    replyHoldAt: messageTimestamp,
                    replyAttribution: 'CAMPAIGN',
                    replyContextMessageId: contextId,
                  },
                }
              );
            } else if (customer) {
              // No reliable context: conservatively hold active SALES sequences for customer/store
              // and label it as NOT campaign attribution (Spec p14, p28)
              logger.info(
                {
                  customerId: customer.customerId,
                  messageId,
                },
                'Inbound reply without context: conservatively holding active sales sequences (NOT_CAMPAIGN_CONSERVATIVE).'
              );

              const activeEnrollments = await CampaignEnrollmentModel.find({
                tenantId,
                customerId: customer.customerId,
                status: 'ACTIVE',
              });

              for (const enr of activeEnrollments) {
                await CampaignEnrollmentModel.updateOne(
                  { tenantId, enrollmentId: enr.enrollmentId },
                  {
                    $set: {
                      replyHoldAt: messageTimestamp,
                      replyAttribution: 'NOT_CAMPAIGN_CONSERVATIVE',
                    },
                  }
                );
              }
            }

            // Inbound review flag: check for configurable phrases (stop, unsubscribe, wrong number, not me, dont message, don't message)
            const textBody = (messageItem.text?.body || messageItem.button?.text || '').trim();
            const textLower = textBody.toLowerCase();

            let reviewReason: 'POSSIBLE_OPT_OUT' | 'POSSIBLE_WRONG_NUMBER' | null = null;
            if (
              textLower === 'stop' ||
              textLower === 'unsubscribe' ||
              textLower === 'dont message' ||
              textLower === "don't message"
            ) {
              reviewReason = 'POSSIBLE_OPT_OUT';
            } else if (textLower === 'wrong number' || textLower === 'not me') {
              reviewReason = 'POSSIBLE_WRONG_NUMBER';
            }

            if (reviewReason) {
              const reviewObj = {
                reason: reviewReason,
                at: messageTimestamp,
                messageId,
              };

              if (matchedEnrollment) {
                await CampaignEnrollmentModel.updateOne(
                  { tenantId, enrollmentId: matchedEnrollment.enrollmentId },
                  { $set: { needsStaffReview: reviewObj } }
                );
              }

              if (customer) {
                await SrcCustomerModel.updateOne(
                  { tenantId, customerId: customer.customerId },
                  { $set: { needsStaffReview: reviewObj } }
                );
              }
            }

            // Durably record provider event
            await CampaignProviderEventModel.create({
              eventId: `cpe_${crypto.randomUUID()}`,
              tenantId,
              phoneNumberId,
              eventType: 'INBOUND_MESSAGE',
              messageId,
              timestamp: messageTimestamp,
              recipientHash: destHash,
              recipientMasked: maskedFrom,
              dedupeKey,
              rawPayload: sanitizePayload(messageItem),
              correlatedExecutionId: matchedExecution?.executionId || null,
              correlatedEnrollmentId: matchedEnrollment?.enrollmentId || null,
              replyAttribution,
              processed: true,
            });
            eventsRecorded++;
            processedInbound++;
          }
        }
      }
    }

    return { processedStatuses, processedInbound, duplicateCount, eventsRecorded };
  }
}

export const webhookService = new WebhookService();

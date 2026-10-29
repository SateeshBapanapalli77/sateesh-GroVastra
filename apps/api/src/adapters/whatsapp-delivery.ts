import crypto from 'crypto';
import {
  EXECUTION_STATE,
  ExecutionState,
  EXECUTION_REASONS,
  DELIVERY_INTENT_STATE,
  DeliveryIntentState,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignProviderEventModel,
  SrcTemplateModel,
  SrcConnectionModel,
  TenantModel,
  ICampaignExecution,
  ICampaignDeliveryIntent,
} from '../db/models';
import { mockCustomerSource } from './customer-source';
import { campaignSettingsService } from '../services/campaign-settings.service';
import { contactGateService } from '../services/contact-gate';
import { clock } from '../services/clock';
import { config } from '../config/env';
import { logger } from '../logger';
import { decryptPhone, destinationHash, normalizePhoneNumber } from '../utils/crypto';
import { buildMetaTemplateBody } from '../templates';

export interface SendCampaignStepInput {
  executionId: string;
  deliveryKey: string;
  connectionId: string;
  customerId: string;
  recipientVersion: number;
  template: {
    id: string;
    revision: number;
    language: string;
  };
  parameters: Record<string, string | number> | Array<{ index?: number; name?: string; text: string }>;
  expiresAt: string | Date;
  tenantId?: string;
  attemptId?: string;
  retryDelayMs?: number; // Optional custom delay for tests
}

export interface SendCampaignStepResult {
  success: boolean;
  state: ExecutionState;
  reason?: string | null;
  providerMessageId?: string | null;
  attemptId: string;
  error?: {
    code?: number;
    message?: string;
    category?: string;
  } | null;
}

/**
 * Evaluates whether a Meta API error code or HTTP status is a transient/throttle error
 * eligible for safe bounded retry under Spec [M4] and C08.
 */
export function isTransientMetaError(code?: number, httpStatus?: number): boolean {
  if (httpStatus === 429 || httpStatus === 500 || httpStatus === 503) {
    return true;
  }
  if (!code) return false;
  // Documented Meta Transient / Throttle codes [M4]:
  // 131056: Spam rate limit hit
  // 130429: Cloud API throughput rate limit hit
  // 80007: Rate limit exceeded
  // 4: Application-level throttle
  // 1: An unknown error occurred (temporary service error)
  // 2: Service temporarily unavailable
  const transientCodes = [131056, 130429, 80007, 4, 1, 2];
  return transientCodes.includes(code);
}

/**
 * Checks if a destination phone hash is in the dev sandbox allowlist.
 */
export function isDestinationInAllowlist(phoneHash: string, allowlistStr?: string): boolean {
  const rawList = allowlistStr ?? process.env.META_TEST_ALLOWLIST ?? config.META_TEST_ALLOWLIST ?? '';
  const entries = rawList
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return false;
  }

  for (const entry of entries) {
    try {
      const normalized = normalizePhoneNumber(entry);
      const hash = destinationHash(normalized);
      if (hash === phoneHash) {
        return true;
      }
    } catch {
      // Ignore invalid allowlist entry formats
    }
  }

  return false;
}

/**
 * Delivery stage implementation for WhatsApp Cloud API (Meta).
 * Strictly conforms to Spec p27 signature and semantics.
 */
export async function sendCampaignStep(input: SendCampaignStepInput): Promise<SendCampaignStepResult> {
  const serverNow = clock.now();
  const attemptId = input.attemptId || `att_${crypto.randomUUID()}`;

  // 1. Recheck expiry deadline AFTER DB commit and immediately before POST (Spec p27)
  const expiresAtDate = new Date(input.expiresAt);
  if (serverNow.getTime() >= expiresAtDate.getTime()) {
    logger.warn(
      { executionId: input.executionId, expiresAt: input.expiresAt, serverNow },
      'sendCampaignStep: Dispatch deadline expired before HTTP call.'
    );

    await CampaignExecutionModel.updateOne(
      { executionId: input.executionId },
      {
        $set: {
          state: EXECUTION_STATE.EXPIRED,
          skipReason: EXECUTION_REASONS.EXPIRED_LATENESS_CUTOFF,
        },
      }
    );

    return {
      success: false,
      state: EXECUTION_STATE.EXPIRED,
      reason: EXECUTION_REASONS.EXPIRED_LATENESS_CUTOFF,
      attemptId,
    };
  }

  // 2. Load execution & resolve tenantId
  let execution = await CampaignExecutionModel.findOne({ executionId: input.executionId });
  const tenantId = input.tenantId || execution?.tenantId;
  if (!tenantId) {
    throw new Error(`Cannot determine tenantId for execution '${input.executionId}'`);
  }

  // 3. Final Pause gates check (read outside transaction per Spec p27)
  const [settings, campaign, controlGate]: [any, any, any] = await Promise.all([
    campaignSettingsService.getSettings(tenantId),
    execution ? CampaignModel.findOne({ tenantId, campaignId: execution.campaignId }).lean() : null,
    execution ? CampaignControlGateModel.findOne({ tenantId, campaignId: execution.campaignId }).lean() : null,
  ]);

  if (settings?.isPaused === true) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.DEFERRED, skipReason: EXECUTION_REASONS.GLOBAL_PAUSED } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.DEFERRED,
      reason: EXECUTION_REASONS.GLOBAL_PAUSED,
      attemptId,
    };
  }

  if (campaign && campaign.status !== 'ACTIVE') {
    const isPaused = campaign.status === 'PAUSED';
    const state = isPaused ? EXECUTION_STATE.DEFERRED : EXECUTION_STATE.CANCELLED;
    const reason = isPaused ? EXECUTION_REASONS.CAMPAIGN_PAUSED : EXECUTION_REASONS.CAMPAIGN_NOT_ACTIVE;
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state, skipReason: reason } }
    );
    return {
      success: false,
      state,
      reason,
      attemptId,
    };
  }

  if (controlGate && campaign && controlGate.pauseGeneration !== campaign.pauseGeneration) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.DEFERRED, skipReason: EXECUTION_REASONS.PAUSE_GENERATION_MISMATCH } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.DEFERRED,
      reason: EXECUTION_REASONS.PAUSE_GENERATION_MISMATCH,
      attemptId,
    };
  }

  // 4. Source revision, permission, and destination final checks
  const customer = await mockCustomerSource.getCustomerById(tenantId, input.customerId);
  if (!customer || customer.deletedAt != null || customer.status === 'DELETED') {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.CANCELLED, skipReason: EXECUTION_REASONS.CUSTOMER_DELETED } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.CANCELLED,
      reason: EXECUTION_REASONS.CUSTOMER_DELETED,
      attemptId,
    };
  }

  if (customer.consent?.channelSuppressed === true) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.CANCELLED, skipReason: EXECUTION_REASONS.CHANNEL_SUPPRESSED } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.CANCELLED,
      reason: EXECUTION_REASONS.CHANNEL_SUPPRESSED,
      attemptId,
    };
  }

  if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.CANCELLED, skipReason: EXECUTION_REASONS.MARKETING_OPT_OUT } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.CANCELLED,
      reason: EXECUTION_REASONS.MARKETING_OPT_OUT,
      attemptId,
    };
  }

  // C20: Check frozen intent source changes before safe retry / dispatch
  if (customer.version !== input.recipientVersion) {
    logger.warn(
      {
        executionId: input.executionId,
        recipientVersion: input.recipientVersion,
        currentCustomerVersion: customer.version,
      },
      'C20: Frozen intent source changed before dispatch -> BLOCKED_STALE_INTENT.'
    );

    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      {
        $set: {
          state: EXECUTION_STATE.BLOCKED,
          skipReason: EXECUTION_REASONS.BLOCKED_STALE_INTENT,
        },
      }
    );

    await CampaignDeliveryIntentModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: DELIVERY_INTENT_STATE.BLOCKED_STALE_INTENT } }
    );

    return {
      success: false,
      state: EXECUTION_STATE.BLOCKED,
      reason: EXECUTION_REASONS.BLOCKED_STALE_INTENT,
      attemptId,
    };
  }

  if (!customer.destination || !customer.destination.encryptedPhone || customer.destination.verified === false) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.SKIPPED, skipReason: EXECUTION_REASONS.INVALID_DESTINATION } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.SKIPPED,
      reason: EXECUTION_REASONS.INVALID_DESTINATION,
      attemptId,
    };
  }

  // 5. Sandbox guard: if recipient is not in META_TEST_ALLOWLIST (matched by destinationHash)
  // Controlled by dev-only flag, off in production (Spec p3, p7, p27)
  const isProduction = process.env.NODE_ENV === 'production';
  const isSandboxGuardDisabled = process.env.DISABLE_SANDBOX_GUARD === 'true';
  const isSandboxGuardActive = !isProduction && !isSandboxGuardDisabled;

  if (isSandboxGuardActive) {
    const isAllowlisted = isDestinationInAllowlist(customer.destination.destinationHash);
    if (!isAllowlisted) {
      logger.warn(
        {
          executionId: input.executionId,
          maskedRecipient: customer.destination.masked,
          destinationHash: customer.destination.destinationHash,
        },
        'Sandbox guard: recipient is not in META_TEST_ALLOWLIST. Blocking execution with zero provider HTTP calls.'
      );

      await CampaignExecutionModel.updateOne(
        { tenantId, executionId: input.executionId },
        {
          $set: {
            state: EXECUTION_STATE.BLOCKED,
            skipReason: EXECUTION_REASONS.SANDBOX_NOT_ALLOWLISTED,
          },
        }
      );

      return {
        success: false,
        state: EXECUTION_STATE.BLOCKED,
        reason: EXECUTION_REASONS.SANDBOX_NOT_ALLOWLISTED,
        attemptId,
      };
    }
  }

  // 6. Template usable and sendable check
  const template: any = await SrcTemplateModel.findOne({ id: input.template.id }).lean();
  if (!template) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.BLOCKED, skipReason: EXECUTION_REASONS.TEMPLATE_NOT_FOUND } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.BLOCKED,
      reason: EXECUTION_REASONS.TEMPLATE_NOT_FOUND,
      attemptId,
    };
  }

  const dispatchMode = (process.env.DISPATCH_MODE || config.DISPATCH_MODE || 'dry').toLowerCase();
  const isDispatchMeta = dispatchMode === 'meta';

  if (template.status !== 'APPROVED' && (isDispatchMeta || template.status !== 'DUMMY')) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.BLOCKED, skipReason: EXECUTION_REASONS.TEMPLATE_NOT_USABLE } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.BLOCKED,
      reason: EXECUTION_REASONS.TEMPLATE_NOT_USABLE,
      attemptId,
    };
  }

  if (isDispatchMeta && template.sendable === false) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.BLOCKED, skipReason: EXECUTION_REASONS.DUMMY_TEMPLATE_BLOCKED } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.BLOCKED,
      reason: EXECUTION_REASONS.DUMMY_TEMPLATE_BLOCKED,
      attemptId,
    };
  }

  // 7. Load Connection details
  const connection: any = await SrcConnectionModel.findOne({ tenantId }).lean();
  if (!connection) {
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.BLOCKED, skipReason: EXECUTION_REASONS.CONNECTION_NOT_FOUND } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.BLOCKED,
      reason: EXECUTION_REASONS.CONNECTION_NOT_FOUND,
      attemptId,
    };
  }

  // If DISPATCH_MODE is dry, record PREPARED_DRY and return without HTTP
  if (!isDispatchMeta) {
    logger.info(
      {
        executionId: input.executionId,
        templateId: input.template.id,
        maskedRecipient: customer.destination.masked,
        mode: 'dry',
      },
      'sendCampaignStep: DISPATCH_MODE=dry. Intent frozen with PREPARED_DRY. Zero provider calls.'
    );

    if (customer.destination?.destinationHash) {
      await contactGateService.markAccepted(tenantId, customer.destination.destinationHash, input.executionId);
    }

    return {
      success: true,
      state: EXECUTION_STATE.DISPATCHING,
      attemptId,
    };
  }

  // =========================================================================
  // PREPARE META GRAPH API REQUEST (Spec p27, [M1])
  // POST https://graph.facebook.com/{graphApiVersion}/{phoneNumberId}/messages
  // =========================================================================
  const graphApiVersion = connection.graphApiVersion || 'v25.0';
  const phoneNumberId = connection.phoneNumberId;
  const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;

  const secretRefKey = connection.secretRef || 'META_ACCESS_TOKEN';
  const token = process.env[secretRefKey];
  if (!token) {
    logger.error(
      { secretRefKey, executionId: input.executionId },
      'sendCampaignStep: SecretRef env key missing in server environment.'
    );
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: input.executionId },
      { $set: { state: EXECUTION_STATE.BLOCKED, skipReason: 'TOKEN_ENV_MISSING' } }
    );
    return {
      success: false,
      state: EXECUTION_STATE.BLOCKED,
      reason: 'TOKEN_ENV_MISSING',
      attemptId,
    };
  }

  // Decrypt recipient destination to digits-only number with country code
  const rawRecipient = decryptPhone(customer.destination.encryptedPhone);
  const digitsOnlyTo = normalizePhoneNumber(rawRecipient);

  // Construct Meta template payload using canonical buildMetaTemplateBody
  const requestBody = buildMetaTemplateBody(template, input.parameters, digitsOnlyTo);

  // Attempt tracking
  execution = await CampaignExecutionModel.findOne({ tenantId, executionId: input.executionId });
  const attemptNumber = (execution?.attemptCount || 0) + 1;

  logger.info(
    {
      executionId: input.executionId,
      attemptId,
      attemptNumber,
      templateName: template.name,
      language: template.language,
      maskedRecipient: customer.destination.masked,
      variableCount: template.variables?.length || 0,
    },
    'sendCampaignStep: Dispatching HTTP POST to Meta WhatsApp Cloud API.'
  );

  // =========================================================================
  // EXECUTE HTTP REQUEST OUTSIDE TRANSACTION (Hard Rule 4)
  // =========================================================================
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10000), // 10s request timeout
    });

    if (response.ok) {
      // Status 200 OK: Persist provider message id (wamid) as accepted evidence
      const data: any = await response.json().catch(() => ({}));
      const providerMessageId = data.messages?.[0]?.id || `wamid_${crypto.randomUUID()}`;

      logger.info(
        {
          executionId: input.executionId,
          attemptId,
          providerMessageId,
          maskedRecipient: customer.destination.masked,
        },
        'sendCampaignStep: Provider accepted WhatsApp message submission (PROVIDER_ACCEPTED).'
      );

      // Check if a provider status event was already received and recorded for this providerMessageId (C12)
      const existingEvents = await CampaignProviderEventModel.find({
        tenantId,
        messageId: providerMessageId,
      })
        .sort({ createdAt: 1 })
        .lean();

      let resolvedState: ExecutionState = EXECUTION_STATE.PROVIDER_ACCEPTED;
      let resolvedIntentState: DeliveryIntentState = DELIVERY_INTENT_STATE.PROVIDER_ACCEPTED;
      let sentAtDate: Date | null = null;
      let deliveredAtDate: Date | null = null;
      let readAtDate: Date | null = null;

      if (existingEvents.length > 0) {
        for (const ev of existingEvents) {
          if (ev.status === 'sent') {
            sentAtDate = ev.timestamp;
            if (resolvedState !== EXECUTION_STATE.READ && resolvedState !== EXECUTION_STATE.DELIVERED) {
              resolvedState = EXECUTION_STATE.SENT;
              resolvedIntentState = DELIVERY_INTENT_STATE.SENT;
            }
          } else if (ev.status === 'delivered') {
            deliveredAtDate = ev.timestamp;
            if (resolvedState !== EXECUTION_STATE.READ) {
              resolvedState = EXECUTION_STATE.DELIVERED;
              resolvedIntentState = DELIVERY_INTENT_STATE.DELIVERED;
            }
          } else if (ev.status === 'read') {
            readAtDate = ev.timestamp;
            resolvedState = EXECUTION_STATE.READ;
            resolvedIntentState = DELIVERY_INTENT_STATE.READ;
          }
        }
      }

      const attemptRecord = {
        attemptId,
        attemptNumber,
        attemptedAt: clock.now(),
        state: resolvedState,
        providerMessageId,
      };

      const executionUpdate: Record<string, any> = {
        state: resolvedState,
        providerMessageId,
        skipReason: null,
        lastErrorCategory: null,
      };
      if (sentAtDate) executionUpdate.sentAt = sentAtDate;
      if (deliveredAtDate) executionUpdate.deliveredAt = deliveredAtDate;
      if (readAtDate) executionUpdate.readAt = readAtDate;

      await Promise.all([
        CampaignExecutionModel.updateOne(
          { tenantId, executionId: input.executionId },
          {
            $set: executionUpdate,
            $inc: { attemptCount: 1 },
            $push: { attempts: attemptRecord },
          }
        ),
        CampaignDeliveryIntentModel.updateOne(
          { tenantId, executionId: input.executionId },
          {
            $set: {
              state: resolvedIntentState,
              providerMessageId,
              lastErrorCategory: null,
            },
            $push: { attempts: attemptRecord },
          }
        ),
      ]);

      if (customer.destination?.destinationHash) {
        await contactGateService.markAccepted(tenantId, customer.destination.destinationHash, input.executionId);
      }

      return {
        success: true,
        state: resolvedState,
        providerMessageId,
        attemptId,
      };
    }

    // Provider HTTP Error (4xx / 5xx)
    const errBody: any = await response.json().catch(() => ({}));
    const metaError = errBody?.error || {};
    const errorCode = metaError.code || response.status;
    const errorMsg = metaError.message || response.statusText || 'Unknown Meta API error';
    const errorSubcode = metaError.error_subcode;

    const isThrottle = isTransientMetaError(errorCode, response.status);

    if (isThrottle) {
      // C08: Proven throttle rejection -> Bounded retry with backoff, same intent and key
      const maxRetries = 3;
      if (attemptNumber < maxRetries) {
        const retryDelayMs = input.retryDelayMs || Math.min(300000, 60000 * attemptNumber);
        const retryAt = new Date(serverNow.getTime() + retryDelayMs);

        logger.warn(
          {
            executionId: input.executionId,
            attemptId,
            attemptNumber,
            errorCode,
            errorSubcode,
            retryAt,
          },
          'C08: Transient throttle rejection from Meta API. Scheduling bounded retry.'
        );

        const attemptRecord = {
          attemptId,
          attemptNumber,
          attemptedAt: clock.now(),
          state: 'REJECTED_TRANSIENT',
          errorCategory: 'THROTTLE_LIMIT',
          errorCode,
          errorMessage: errorMsg,
        };

        await Promise.all([
          CampaignExecutionModel.updateOne(
            { tenantId, executionId: input.executionId },
            {
              $set: {
                state: EXECUTION_STATE.DEFERRED,
                skipReason: EXECUTION_REASONS.RETRY_WAIT,
                retryAt,
                dueAt: retryAt,
                lastErrorCategory: 'THROTTLE_LIMIT',
              },
              $inc: { attemptCount: 1 },
              $push: { attempts: attemptRecord },
            }
          ),
          CampaignDeliveryIntentModel.updateOne(
            { tenantId, executionId: input.executionId },
            {
              $set: {
                lastErrorCategory: 'THROTTLE_LIMIT',
                retryAt,
              },
              $push: { attempts: attemptRecord },
            }
          ),
        ]);

        if (customer.destination?.destinationHash) {
          await contactGateService.releaseReservation(
            tenantId,
            customer.destination.destinationHash,
            input.executionId,
            'PROVEN_NON_ACCEPTANCE_TRANSIENT_RETRY'
          );
        }

        return {
          success: false,
          state: EXECUTION_STATE.DEFERRED,
          reason: EXECUTION_REASONS.RETRY_WAIT,
          attemptId,
          error: {
            code: errorCode,
            message: errorMsg,
            category: 'THROTTLE_LIMIT',
          },
        };
      }
    }

    // Check for parameter rejection errors (132000, 132012, 132018) vs template paused (132015)
    const isTemplatePaused = errorCode === 132015 || errorSubcode === 132015;
    const isParameterError =
      errorCode === 132000 ||
      errorCode === 132012 ||
      errorCode === 132018 ||
      errorSubcode === 132000 ||
      errorSubcode === 132012 ||
      errorSubcode === 132018;

    if (isTemplatePaused) {
      logger.warn(
        {
          executionId: input.executionId,
          attemptId,
          errorCode,
          errorMsg,
        },
        'Meta Cloud API rejection: Template is paused (132015) -> BLOCKED_TEMPLATE.'
      );

      const attemptRecord = {
        attemptId,
        attemptNumber,
        attemptedAt: clock.now(),
        state: EXECUTION_STATE.BLOCKED,
        errorCategory: 'TEMPLATE_PAUSED',
        errorCode,
        errorMessage: errorMsg,
      };

      await Promise.all([
        CampaignExecutionModel.updateOne(
          { tenantId, executionId: input.executionId },
          {
            $set: {
              state: EXECUTION_STATE.BLOCKED,
              skipReason: EXECUTION_REASONS.BLOCKED_TEMPLATE,
              lastErrorCategory: 'TEMPLATE_PAUSED',
            },
            $inc: { attemptCount: 1 },
            $push: { attempts: attemptRecord },
          }
        ),
        CampaignDeliveryIntentModel.updateOne(
          { tenantId, executionId: input.executionId },
          {
            $set: {
              state: 'BLOCKED_TEMPLATE',
              lastErrorCategory: 'TEMPLATE_PAUSED',
            },
            $push: { attempts: attemptRecord },
          }
        ),
      ]);

      if (customer.destination?.destinationHash) {
        await contactGateService.releaseReservation(
          tenantId,
          customer.destination.destinationHash,
          input.executionId,
          'PROVEN_NON_ACCEPTANCE_PERMANENT'
        );
      }

      return {
        success: false,
        state: EXECUTION_STATE.BLOCKED,
        reason: EXECUTION_REASONS.BLOCKED_TEMPLATE,
        attemptId,
        error: {
          code: errorCode,
          message: errorMsg,
          category: 'TEMPLATE_PAUSED',
        },
      };
    }

    if (isParameterError) {
      logger.error(
        {
          executionId: input.executionId,
          attemptId,
          errorCode,
          errorSubcode,
          errorMsg,
        },
        'Meta Cloud API rejection: Parameter rejected by provider (132000/132012/132018) -> FAILED, no retry.'
      );

      const attemptRecord = {
        attemptId,
        attemptNumber,
        attemptedAt: clock.now(),
        state: EXECUTION_STATE.FAILED,
        errorCategory: 'PARAMETER_REJECTED_BY_PROVIDER',
        errorCode,
        errorMessage: errorMsg,
      };

      await Promise.all([
        CampaignExecutionModel.updateOne(
          { tenantId, executionId: input.executionId },
          {
            $set: {
              state: EXECUTION_STATE.FAILED,
              skipReason: EXECUTION_REASONS.PARAMETER_REJECTED_BY_PROVIDER,
              lastErrorCategory: 'PARAMETER_REJECTED_BY_PROVIDER',
            },
            $inc: { attemptCount: 1 },
            $push: { attempts: attemptRecord },
          }
        ),
        CampaignDeliveryIntentModel.updateOne(
          { tenantId, executionId: input.executionId },
          {
            $set: {
              state: DELIVERY_INTENT_STATE.FAILED,
              lastErrorCategory: 'PARAMETER_REJECTED_BY_PROVIDER',
            },
            $push: { attempts: attemptRecord },
          }
        ),
      ]);

      if (customer.destination?.destinationHash) {
        await contactGateService.releaseReservation(
          tenantId,
          customer.destination.destinationHash,
          input.executionId,
          'PROVEN_NON_ACCEPTANCE_PERMANENT'
        );
      }

      return {
        success: false,
        state: EXECUTION_STATE.FAILED,
        reason: EXECUTION_REASONS.PARAMETER_REJECTED_BY_PROVIDER,
        attemptId,
        error: {
          code: errorCode,
          message: errorMsg,
          category: 'PARAMETER_REJECTED_BY_PROVIDER',
        },
      };
    }

    // Generic Permanent Rejection: Nonexistent template, unapproved token, etc. -> FAILED
    logger.error(
      {
        executionId: input.executionId,
        attemptId,
        attemptNumber,
        errorCode,
        errorSubcode,
        errorMsg,
      },
      'sendCampaignStep: Permanent non-acceptance rejection from Meta API -> FAILED.'
    );

    const attemptRecord = {
      attemptId,
      attemptNumber,
      attemptedAt: clock.now(),
      state: EXECUTION_STATE.FAILED,
      errorCategory: 'PERMANENT_REJECTION',
      errorCode,
      errorMessage: errorMsg,
    };

    await Promise.all([
      CampaignExecutionModel.updateOne(
        { tenantId, executionId: input.executionId },
        {
          $set: {
            state: EXECUTION_STATE.FAILED,
            skipReason: errorMsg,
            lastErrorCategory: 'PERMANENT_REJECTION',
          },
          $inc: { attemptCount: 1 },
          $push: { attempts: attemptRecord },
        }
      ),
      CampaignDeliveryIntentModel.updateOne(
        { tenantId, executionId: input.executionId },
        {
          $set: {
            state: DELIVERY_INTENT_STATE.FAILED,
            lastErrorCategory: 'PERMANENT_REJECTION',
          },
          $push: { attempts: attemptRecord },
        }
      ),
    ]);

    if (customer.destination?.destinationHash) {
      await contactGateService.releaseReservation(
        tenantId,
        customer.destination.destinationHash,
        input.executionId,
        'PROVEN_NON_ACCEPTANCE_PERMANENT'
      );
    }

    return {
      success: false,
      state: EXECUTION_STATE.FAILED,
      reason: errorMsg,
      attemptId,
      error: {
        code: errorCode,
        message: errorMsg,
        category: 'PERMANENT_REJECTION',
      },
    };
  } catch (netErr: any) {
    // C06 / Timeout / Ambiguous network disconnect after DISPATCHING:
    // Mark OUTCOME_UNKNOWN, NO automatic resend (Spec p27)
    logger.error(
      {
        executionId: input.executionId,
        attemptId,
        errName: netErr?.name,
        errMsg: netErr?.message,
      },
      'C06: HTTP network error / timeout after submission -> OUTCOME_UNKNOWN. No automatic resend.'
    );

    const attemptRecord = {
      attemptId,
      attemptNumber,
      attemptedAt: clock.now(),
      state: EXECUTION_STATE.OUTCOME_UNKNOWN,
      errorCategory: 'NETWORK_TIMEOUT',
      errorMessage: netErr?.message || 'Timeout / network failure',
    };

    await Promise.all([
      CampaignExecutionModel.updateOne(
        { tenantId, executionId: input.executionId },
        {
          $set: {
            state: EXECUTION_STATE.OUTCOME_UNKNOWN,
            skipReason: EXECUTION_REASONS.TIMEOUT_OR_NETWORK_ERROR,
            lastErrorCategory: 'NETWORK_TIMEOUT',
          },
          $inc: { attemptCount: 1 },
          $push: { attempts: attemptRecord },
        }
      ),
      CampaignDeliveryIntentModel.updateOne(
        { tenantId, executionId: input.executionId },
        {
          $set: {
            state: DELIVERY_INTENT_STATE.OUTCOME_UNKNOWN,
            lastErrorCategory: 'NETWORK_TIMEOUT',
          },
          $push: { attempts: attemptRecord },
        }
      ),
    ]);

    if (customer.destination?.destinationHash) {
      await contactGateService.markOutcomeUnknown(tenantId, customer.destination.destinationHash, input.executionId);
    }

    return {
      success: false,
      state: EXECUTION_STATE.OUTCOME_UNKNOWN,
      reason: EXECUTION_REASONS.TIMEOUT_OR_NETWORK_ERROR,
      attemptId,
      error: {
        category: 'NETWORK_TIMEOUT',
        message: netErr?.message,
      },
    };
  }
}

/**
 * Sweeper moves stale DISPATCHING attempts to OUTCOME_UNKNOWN after a bounded deadline.
 * Strictly adheres to Spec p27 (C07: Crash after DISPATCHING before HTTP -> OUTCOME_UNKNOWN, no blind requeue).
 */
export async function sweepStaleDispatching(cutoffMs = 60000): Promise<number> {
  const serverNow = clock.now();
  const cutoffTime = new Date(serverNow.getTime() - cutoffMs);

  const staleExecutions = await CampaignExecutionModel.find({
    state: EXECUTION_STATE.DISPATCHING,
    updatedAt: { $lte: cutoffTime },
  }).lean<ICampaignExecution[]>();

  if (staleExecutions.length === 0) {
    return 0;
  }

  logger.warn(
    { count: staleExecutions.length, cutoffTime },
    'sweepStaleDispatching: Sweeping stale DISPATCHING executions into OUTCOME_UNKNOWN.'
  );

  for (const ex of staleExecutions) {
    const attemptRecord = {
      attemptId: `sweep_${crypto.randomUUID()}`,
      attemptNumber: (ex.attemptCount || 0) + 1,
      attemptedAt: serverNow,
      state: EXECUTION_STATE.OUTCOME_UNKNOWN,
      errorCategory: 'DISPATCHING_TIMEOUT_SWEPT',
      errorMessage: 'Stale DISPATCHING execution swept to OUTCOME_UNKNOWN after deadline',
    };

    await Promise.all([
      CampaignExecutionModel.updateOne(
        { tenantId: ex.tenantId, executionId: ex.executionId, state: EXECUTION_STATE.DISPATCHING },
        {
          $set: {
            state: EXECUTION_STATE.OUTCOME_UNKNOWN,
            skipReason: EXECUTION_REASONS.DISPATCH_TIMEOUT_SWEPT,
            lastErrorCategory: 'DISPATCHING_TIMEOUT_SWEPT',
          },
          $push: { attempts: attemptRecord },
        }
      ),
      CampaignDeliveryIntentModel.updateOne(
        { tenantId: ex.tenantId, executionId: ex.executionId },
        {
          $set: {
            state: DELIVERY_INTENT_STATE.OUTCOME_UNKNOWN,
            lastErrorCategory: 'DISPATCHING_TIMEOUT_SWEPT',
          },
          $push: { attempts: attemptRecord },
        }
      ),
    ]);
  }

  return staleExecutions.length;
}

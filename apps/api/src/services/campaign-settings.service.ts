import {
  CampaignSettings,
  UpdateCampaignSettingsInput,
  CAMPAIGN_SETTINGS_LIMITS,
  DEFAULT_CAMPAIGN_SETTINGS,
  UpdateCampaignSettingsSchema,
} from '@grovastra/shared';
import { CampaignSettingsModel, ICampaignSettings } from '../db/models/campaign-settings.model';
import { TenantControlGateModel } from '../db/models/tenant-control-gate.model';
import { ConflictError, ValidationError } from '../errors/app-error';
import { auditService } from './audit.service';
import { logger } from '../logger/logger';

export interface UpdateSettingsParams {
  tenantId: string;
  userId: string;
  expectedVersion: number;
  idempotencyKey: string;
  data: UpdateCampaignSettingsInput;
  ip?: string;
  userAgent?: string;
}

export function sanitizeSettings(doc: ICampaignSettings): CampaignSettings {
  const obj = doc.toObject ? doc.toObject() : doc;
  return {
    id: obj._id?.toString() || obj.id,
    tenantId: obj.tenantId,
    version: obj.version,
    timezone: obj.timezone,
    allowedSendingHours: {
      start: obj.allowedSendingHours?.start || DEFAULT_CAMPAIGN_SETTINGS.allowedSendingHours.start,
      end: obj.allowedSendingHours?.end || DEFAULT_CAMPAIGN_SETTINGS.allowedSendingHours.end,
    },
    blackoutDates: Array.isArray(obj.blackoutDates) ? [...obj.blackoutDates] : [],
    holidays: Array.isArray(obj.holidays)
      ? obj.holidays.map((h: { date: string; name: string }) => ({ date: h.date, name: h.name }))
      : [],
    marketingCaps: {
      daily: obj.marketingCaps?.daily ?? DEFAULT_CAMPAIGN_SETTINGS.marketingCaps.daily,
      weekly: obj.marketingCaps?.weekly ?? DEFAULT_CAMPAIGN_SETTINGS.marketingCaps.weekly,
    },
    serviceContactSpacingHours:
      obj.serviceContactSpacingHours ?? DEFAULT_CAMPAIGN_SETTINGS.serviceContactSpacingHours,
    outageGraceHours: obj.outageGraceHours ?? DEFAULT_CAMPAIGN_SETTINGS.outageGraceHours,
    resumePolicy: 'FUTURE_ONLY',
    importPolicy: 'FUTURE_ONLY',
    priorityAllowlistRanges: {
      birthday: obj.priorityAllowlistRanges?.birthday ?? DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges.birthday,
      anniversary: obj.priorityAllowlistRanges?.anniversary ?? DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges.anniversary,
      wedding: obj.priorityAllowlistRanges?.wedding ?? DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges.wedding,
      requestedStock: obj.priorityAllowlistRanges?.requestedStock ?? DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges.requestedStock,
      festival: obj.priorityAllowlistRanges?.festival ?? DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges.festival,
      winBack: obj.priorityAllowlistRanges?.winBack ?? DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges.winBack,
      ...obj.priorityAllowlistRanges,
    },
    defaultPhoneCountry: obj.defaultPhoneCountry || 'IN',
    minDestinationVerification: obj.minDestinationVerification || 'CONFIRMED_BY_STAFF',
    bookingLinkUrl: obj.bookingLinkUrl ?? null,
    isPaused: Boolean(obj.isPaused),
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

export class CampaignSettingsService {
  /**
   * Retrieves tenant campaign settings, initializing defaults with version 1 if not yet created.
   */
  public async getSettings(tenantId: string): Promise<CampaignSettings> {
    let settings = await CampaignSettingsModel.findOne({ tenantId });
    if (!settings) {
      logger.info({ tenantId }, 'Initializing default campaign settings for tenant');
      settings = await CampaignSettingsModel.create({
        tenantId,
        version: 1,
        timezone: DEFAULT_CAMPAIGN_SETTINGS.timezone,
        allowedSendingHours: { ...DEFAULT_CAMPAIGN_SETTINGS.allowedSendingHours },
        blackoutDates: [...DEFAULT_CAMPAIGN_SETTINGS.blackoutDates],
        holidays: [...DEFAULT_CAMPAIGN_SETTINGS.holidays],
        marketingCaps: { ...DEFAULT_CAMPAIGN_SETTINGS.marketingCaps },
        serviceContactSpacingHours: DEFAULT_CAMPAIGN_SETTINGS.serviceContactSpacingHours,
        outageGraceHours: DEFAULT_CAMPAIGN_SETTINGS.outageGraceHours,
        resumePolicy: 'FUTURE_ONLY',
        importPolicy: 'FUTURE_ONLY',
        priorityAllowlistRanges: { ...DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges },
        defaultPhoneCountry: 'IN',
        minDestinationVerification: 'CONFIRMED_BY_STAFF',
        isPaused: false,
      });
    }

    // Ensure tenant control gate document exists
    await TenantControlGateModel.findOneAndUpdate(
      { tenantId },
      {
        $setOnInsert: {
          tenantId,
          isPaused: Boolean(settings.isPaused),
          pauseGeneration: 0,
          version: 1,
        },
      },
      { upsert: true }
    );

    return sanitizeSettings(settings);
  }

  /**
   * Updates tenant campaign settings with expectedVersion optimistic locking,
   * idempotency key caching, and comprehensive audit logging.
   */
  public async updateSettings(params: UpdateSettingsParams): Promise<CampaignSettings> {
    const { tenantId, userId, expectedVersion, idempotencyKey, data, ip, userAgent } = params;

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new ValidationError('An Idempotency-Key header is required for modifying campaign settings');
    }

    // 1. Load current settings or initialize
    let current = await CampaignSettingsModel.findOne({ tenantId });
    if (!current) {
      current = await CampaignSettingsModel.create({
        tenantId,
        version: 1,
        timezone: DEFAULT_CAMPAIGN_SETTINGS.timezone,
        allowedSendingHours: { ...DEFAULT_CAMPAIGN_SETTINGS.allowedSendingHours },
        blackoutDates: [...DEFAULT_CAMPAIGN_SETTINGS.blackoutDates],
        holidays: [...DEFAULT_CAMPAIGN_SETTINGS.holidays],
        marketingCaps: { ...DEFAULT_CAMPAIGN_SETTINGS.marketingCaps },
        serviceContactSpacingHours: DEFAULT_CAMPAIGN_SETTINGS.serviceContactSpacingHours,
        outageGraceHours: DEFAULT_CAMPAIGN_SETTINGS.outageGraceHours,
        resumePolicy: 'FUTURE_ONLY',
        importPolicy: 'FUTURE_ONLY',
        priorityAllowlistRanges: { ...DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges },
        defaultPhoneCountry: 'IN',
        minDestinationVerification: 'CONFIRMED_BY_STAFF',
        isPaused: false,
      });
    }

    // 2. Check Idempotency Key
    if (current.lastIdempotencyKey === idempotencyKey.trim() && current.lastResponse) {
      logger.info(
        { tenantId, idempotencyKey: idempotencyKey.trim(), version: current.version },
        'Returning cached response for repeated idempotency key'
      );
      return current.lastResponse as unknown as CampaignSettings;
    }

    // 3. Optimistic locking check: expectedVersion must match current version (409 Conflict)
    if (current.version !== expectedVersion) {
      logger.warn(
        { tenantId, expectedVersion, currentVersion: current.version },
        'Campaign settings version conflict detected'
      );
      throw new ConflictError(
        `Campaign settings version conflict. Expected version ${expectedVersion} but current version is ${current.version}.`,
        {
          expectedVersion,
          currentVersion: current.version,
        }
      );
    }

    // 4. Validate input schema with Zod
    const validated = UpdateCampaignSettingsSchema.parse({
      ...data,
      expectedVersion,
    });

    // 5. Tenant maximum cap tightening enforcement (Spec p7, p18)
    // Owners may only TIGHTEN inherited caps, never loosen beyond the tenant maximum.
    if (validated.marketingCaps) {
      if (
        validated.marketingCaps.daily !== undefined &&
        validated.marketingCaps.daily > CAMPAIGN_SETTINGS_LIMITS.MAX_DAILY_MARKETING_CAP
      ) {
        throw new ValidationError(
          `Daily marketing cap cannot exceed tenant maximum of ${CAMPAIGN_SETTINGS_LIMITS.MAX_DAILY_MARKETING_CAP} per 24 hours (spec p7, p18)`,
          {
            field: 'marketingCaps.daily',
            tenantMax: CAMPAIGN_SETTINGS_LIMITS.MAX_DAILY_MARKETING_CAP,
            provided: validated.marketingCaps.daily,
          }
        );
      }
      if (
        validated.marketingCaps.weekly !== undefined &&
        validated.marketingCaps.weekly > CAMPAIGN_SETTINGS_LIMITS.MAX_WEEKLY_MARKETING_CAP
      ) {
        throw new ValidationError(
          `Weekly marketing cap cannot exceed tenant maximum of ${CAMPAIGN_SETTINGS_LIMITS.MAX_WEEKLY_MARKETING_CAP} per 7 days (spec p7, p18)`,
          {
            field: 'marketingCaps.weekly',
            tenantMax: CAMPAIGN_SETTINGS_LIMITS.MAX_WEEKLY_MARKETING_CAP,
            provided: validated.marketingCaps.weekly,
          }
        );
      }
    }

    // 6. Capture old snapshot for audit log
    const oldSnapshot = sanitizeSettings(current);

    // 7. Apply updates
    if (validated.timezone !== undefined) {
      current.timezone = validated.timezone;
    }
    if (validated.allowedSendingHours !== undefined) {
      current.allowedSendingHours = {
        start: validated.allowedSendingHours.start,
        end: validated.allowedSendingHours.end,
      };
    }
    if (validated.blackoutDates !== undefined) {
      current.blackoutDates = [...validated.blackoutDates];
    }
    if (validated.holidays !== undefined) {
      current.holidays = validated.holidays.map((h) => ({ date: h.date, name: h.name }));
    }
    if (validated.marketingCaps !== undefined) {
      current.marketingCaps = {
        daily: validated.marketingCaps.daily ?? current.marketingCaps.daily,
        weekly: validated.marketingCaps.weekly ?? current.marketingCaps.weekly,
      };
    }
    if (validated.serviceContactSpacingHours !== undefined) {
      current.serviceContactSpacingHours = validated.serviceContactSpacingHours;
    }
    if (validated.outageGraceHours !== undefined) {
      current.outageGraceHours = validated.outageGraceHours;
    }
    if (validated.resumePolicy !== undefined) {
      current.resumePolicy = validated.resumePolicy;
    }
    if (validated.importPolicy !== undefined) {
      current.importPolicy = validated.importPolicy;
    }
    if (validated.priorityAllowlistRanges !== undefined) {
      current.priorityAllowlistRanges = {
        ...current.priorityAllowlistRanges,
        ...validated.priorityAllowlistRanges,
      };
    }
    if (validated.defaultPhoneCountry !== undefined) {
      current.defaultPhoneCountry = validated.defaultPhoneCountry;
    }
    if (validated.minDestinationVerification !== undefined) {
      current.minDestinationVerification = validated.minDestinationVerification;
    }
    if (validated.bookingLinkUrl !== undefined) {
      current.bookingLinkUrl = validated.bookingLinkUrl ? validated.bookingLinkUrl.trim() : null;
    }
    if (validated.isPaused !== undefined) {
      const isPausedChanged = current.isPaused !== validated.isPaused;
      current.isPaused = validated.isPaused;

      // Keep TenantControlGate document synchronized with tenant global pause (Spec p25)
      await TenantControlGateModel.findOneAndUpdate(
        { tenantId },
        {
          $set: { isPaused: validated.isPaused },
          ...(isPausedChanged ? { $inc: { pauseGeneration: 1, version: 1 } } : {}),
        },
        { upsert: true, new: true }
      );
    }

    // Increment version & record idempotency key
    current.version = current.version + 1;
    current.lastIdempotencyKey = idempotencyKey.trim();

    await current.save();

    const newSnapshot = sanitizeSettings(current);
    current.lastResponse = newSnapshot as unknown as Record<string, unknown>;
    await current.save();

    // 8. Record immutable audit log
    await auditService.logEvent({
      tenantId,
      userId,
      action: 'campaign_settings.updated',
      metadata: {
        old: oldSnapshot,
        new: newSnapshot,
        expectedVersion,
        newVersion: current.version,
        idempotencyKey: idempotencyKey.trim(),
      },
      ip,
      userAgent,
    });

    logger.info(
      { tenantId, userId, oldVersion: expectedVersion, newVersion: current.version },
      'Campaign settings successfully updated'
    );

    return newSnapshot;
  }
}

export const campaignSettingsService = new CampaignSettingsService();

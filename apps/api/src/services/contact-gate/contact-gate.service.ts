import mongoose, { ClientSession } from 'mongoose';
import {
  CampaignSettings,
  EXECUTION_REASONS,
  EXECUTION_STATE,
  SourceTemplate,
} from '@grovastra/shared';
import {
  CampaignContactGateModel,
  ICampaignContactGate,
  ICampaignContactLedgerEntry,
  ContactLedgerStatus,
  ContactLedgerPurpose,
  CampaignSettingsModel,
  CampaignControlGateModel,
  TenantControlGateModel,
  ICampaignExecution,
  CampaignExecutionModel,
  CampaignEnrollmentModel,
} from '../../db/models';
import { mockCustomerSource } from '../../adapters/customer-source';
import { fitIntoAllowedHours } from '../datetime';
import { clock } from '../clock';
import { logger } from '../../logger';

export interface CapacityCheckResult {
  allowed: boolean;
  reason?: string;
  dailyCount: number;
  weeklyCount: number;
  dailyCap: number;
  weeklyCap: number;
  gate?: ICampaignContactGate | null;
  earliestAvailableAt?: Date;
}

export interface NextSlotResult {
  shouldSkip: boolean;
  skipReason?: string;
  nextDueAt?: Date;
  originalDueAt?: Date;
}

export class ContactGateService {
  /**
   * Resolves the effective purpose of an execution.
   * Conforms to Spec p18, p32, and QA Matrix C14:
   * "Service update labelled as marketing escape: Registry/source-purpose rules prevent cap bypass.
   * A marketing template cannot bypass caps by claiming a service purpose."
   */
  resolveEffectivePurpose(
    templateCategory?: string | null,
    campaignPresetId?: string | null,
    declaredPurpose?: string | null
  ): ContactLedgerPurpose {
    const normCategory = (templateCategory || '').toUpperCase();
    const isMarketingTemplate = normCategory === 'MARKETING';
    const normPreset = (campaignPresetId || '').toLowerCase();
    const servicePresets = [
      'enquiry',
      'order_status',
      'appointment_reminder',
      'support',
      'fitting_alteration',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
      'outfit_collection_delivery',
      'outfit_collection',
      'outfit_fulfilment',
      'fulfilment_milestone',
    ];
    const isServicePreset = servicePresets.includes(normPreset);

    // C14: If template is MARKETING or declaredPurpose is MARKETING or it is not an authentic service preset,
    // purpose is STRICTLY MARKETING. A promotional message cannot bypass caps by claiming SERVICE.
    if (isMarketingTemplate || declaredPurpose === 'MARKETING') {
      return 'MARKETING';
    }

    if (declaredPurpose === 'SERVICE' && isServicePreset && normCategory === 'UTILITY') {
      return 'SERVICE';
    }

    // Any other combination (including promotional presets or undefined) defaults to MARKETING
    return 'MARKETING';
  }

  /**
   * Retrieves or initializes a destination gate for a tenant.
   */
  async getGate(
    tenantId: string,
    destinationHash: string,
    session?: ClientSession
  ): Promise<ICampaignContactGate | null> {
    const query = CampaignContactGateModel.findOne({ tenantId, destinationHash });
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * Counts active contact ledger entries in the rolling window (now - windowMs, now].
   * Conforms to Spec p18:
   * "Keep one rolling contact-ledger entry per execution, timestamped at reservation.
   * Count entries in (now-window, now]; accepted/unknown entries age out normally,
   * while unresolved submissions also retain their in-flight lock.
   * Only proven non-acceptance releases that attempt's reservation.
   * A safe retry reserves again at the new attempt time under the same execution key,
   * without double counting. Lease expiry alone never releases an uncertain contact."
   */
  countActiveContacts(
    gate: ICampaignContactGate | null | undefined,
    now: Date,
    windowMs: number,
    purpose: ContactLedgerPurpose = 'MARKETING',
    excludeExecutionId?: string
  ): { count: number; activeEntries: ICampaignContactLedgerEntry[] } {
    if (!gate || !gate.ledger || gate.ledger.length === 0) {
      return { count: 0, activeEntries: [] };
    }

    const windowStartMs = now.getTime() - windowMs;
    const nowMs = now.getTime();

    const activeEntries = gate.ledger.filter((entry) => {
      // Must match purpose
      if (entry.purpose !== purpose) return false;

      // Only PROVEN non-acceptance releases a reservation
      if (entry.status === 'RELEASED') return false;

      // Safe retry under the same execution key does not double count
      if (excludeExecutionId && entry.executionId === excludeExecutionId) return false;

      // 1. Unresolved submissions (RESERVED) retain their in-flight lock regardless of age
      if (entry.status === 'RESERVED') {
        return true;
      }

      // 2. Accepted and unknown entries age out normally in (now - window, now]
      const reservedTime = new Date(entry.reservedAt).getTime();
      return reservedTime > windowStartMs && reservedTime <= nowMs;
    });

    return {
      count: activeEntries.length,
      activeEntries,
    };
  }

  /**
   * Checks contact capacity for a destination against tenant daily and weekly marketing caps.
   * Caps are tenant-wide, count all campaigns AND customer records sharing one destination.
   */
  async checkCapacity(
    tenantId: string,
    destinationHash: string,
    now: Date,
    settings: CampaignSettings,
    excludeExecutionId?: string,
    purpose: ContactLedgerPurpose = 'MARKETING',
    session?: ClientSession
  ): Promise<CapacityCheckResult> {
    const gate = await this.getGate(tenantId, destinationHash, session);

    if (purpose === 'SERVICE') {
      const spacingHours = settings.serviceContactSpacingHours ?? 24;
      const spacingMs = spacingHours * 60 * 60 * 1000;
      const serviceEntries = (gate?.ledger || [])
        .filter(
          (e: any) =>
            e.purpose === 'SERVICE' &&
            e.status !== 'RELEASED' &&
            e.executionId !== excludeExecutionId
        )
        .sort((a: any, b: any) => new Date(b.reservedAt).getTime() - new Date(a.reservedAt).getTime());

      const lastService = serviceEntries[0];
      if (lastService) {
        const lastTime = new Date(lastService.reservedAt).getTime();
        const elapsed = now.getTime() - lastTime;
        if (elapsed < spacingMs) {
          const earliestAvailableAt = new Date(lastTime + spacingMs + 1000);
          return {
            allowed: false,
            reason: 'SERVICE_SPACING_LIMIT',
            dailyCount: 0,
            weeklyCount: 0,
            dailyCap: Infinity,
            weeklyCap: Infinity,
            gate,
            earliestAvailableAt,
          };
        }
      }

      return {
        allowed: true,
        dailyCount: 0,
        weeklyCount: 0,
        dailyCap: Infinity,
        weeklyCap: Infinity,
        gate,
      };
    }

    const dailyCap = settings.marketingCaps?.daily ?? 1;
    const weeklyCap = settings.marketingCaps?.weekly ?? 3;

    const DAY_MS = 24 * 60 * 60 * 1000;
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    const { count: dailyCount, activeEntries: dailyEntries } = this.countActiveContacts(
      gate,
      now,
      DAY_MS,
      purpose,
      excludeExecutionId
    );

    const { count: weeklyCount, activeEntries: weeklyEntries } = this.countActiveContacts(
      gate,
      now,
      WEEK_MS,
      purpose,
      excludeExecutionId
    );

    if (dailyCount >= dailyCap) {
      // Find earliest time daily cap frees up
      const sortedDaily = [...dailyEntries].sort(
        (a, b) => new Date(a.reservedAt).getTime() - new Date(b.reservedAt).getTime()
      );
      const oldestDaily = sortedDaily[0];
      const earliestAvailableAt = oldestDaily
        ? new Date(new Date(oldestDaily.reservedAt).getTime() + DAY_MS + 1000)
        : new Date(now.getTime() + DAY_MS);

      return {
        allowed: false,
        reason: 'DAILY_CAP_REACHED',
        dailyCount,
        weeklyCount,
        dailyCap,
        weeklyCap,
        gate,
        earliestAvailableAt,
      };
    }

    if (weeklyCount >= weeklyCap) {
      // Find earliest time weekly cap frees up
      const sortedWeekly = [...weeklyEntries].sort(
        (a, b) => new Date(a.reservedAt).getTime() - new Date(b.reservedAt).getTime()
      );
      const oldestWeekly = sortedWeekly[0];
      const earliestAvailableAt = oldestWeekly
        ? new Date(new Date(oldestWeekly.reservedAt).getTime() + WEEK_MS + 1000)
        : new Date(now.getTime() + WEEK_MS);

      return {
        allowed: false,
        reason: 'WEEKLY_CAP_REACHED',
        dailyCount,
        weeklyCount,
        dailyCap,
        weeklyCap,
        gate,
        earliestAvailableAt,
      };
    }

    return {
      allowed: true,
      dailyCount,
      weeklyCount,
      dailyCap,
      weeklyCap,
      gate,
    };
  }

  /**
   * Calculates the next available sending slot for a losing or cap-constrained step.
   * Conforms to Spec p18:
   * "The losing step is deferred to the next available slot only if it remains useful;
   * otherwise record SKIPPED_CONTACT_CAP."
   */
  calculateNextAvailableSlot(
    gate: ICampaignContactGate | null | undefined,
    now: Date,
    settings: CampaignSettings,
    execution: ICampaignExecution,
    earliestAvailableHint?: Date
  ): NextSlotResult {
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Minimum wait until next candidate slot is 24 hours from now
    // or when the capacity frees up
    let candidateTime = earliestAvailableHint
      ? new Date(Math.max(earliestAvailableHint.getTime(), now.getTime() + 60 * 1000))
      : new Date(now.getTime() + DAY_MS);

    // If candidate time is earlier than next day at sending start hour, ensure we target valid hours
    const fitResult = fitIntoAllowedHours(candidateTime, settings, execution.expiresAt);

    const isService =
      (execution as any).purpose === 'SERVICE' ||
      (execution as any).effectivePurpose === 'SERVICE' ||
      (execution as any).executionKey?.includes(':ready:') ||
      (execution as any).executionKey?.includes(':dispatch:') ||
      (execution as any).executionKey?.includes(':delivered:');

    if (fitResult.status === 'SKIP' || fitResult.dueAt.getTime() > new Date(execution.expiresAt).getTime()) {
      return {
        shouldSkip: true,
        skipReason: isService ? 'SKIPPED_SERVICE_SPACING' : EXECUTION_REASONS.SKIPPED_CONTACT_CAP,
        originalDueAt: execution.originalDueAt || execution.dueAt,
      };
    }

    return {
      shouldSkip: false,
      nextDueAt: fitResult.dueAt,
      originalDueAt: execution.originalDueAt || execution.dueAt,
    };
  }

  /**
   * Atomically reserves contact capacity inside a Mongo transaction in consistent lock order (Spec p25):
   * Order:
   * 1. Tenant Gate (campaignSettings)
   * 2. Campaign Gate (campaignControlGates)
   * 3. Destination Gate (campaignContactGates)
   *
   * Count entries in (now-window, now]; append/update rolling ledger entry; increment version.
   */
  async reserveContactCapacityAtomic(
    session: ClientSession,
    tenantId: string,
    campaignId: string,
    destinationHash: string,
    executionId: string,
    purpose: ContactLedgerPurpose,
    serverNow: Date,
    settings: CampaignSettings,
    expectedPauseGeneration?: number,
    expectedTenantPauseGeneration?: number
  ): Promise<ICampaignContactGate> {
    // 1. Lock/Conditional-Update Tenant Gate (Spec p25)
    let tenantGate: any = await TenantControlGateModel.findOneAndUpdate(
      {
        tenantId,
        isPaused: false,
        ...(expectedTenantPauseGeneration !== undefined ? { pauseGeneration: expectedTenantPauseGeneration } : {}),
      },
      { $inc: { version: 1 } },
      { session, new: true }
    );

    if (!tenantGate) {
      const existing = await TenantControlGateModel.findOne({ tenantId }).session(session);
      if (existing) {
        if (existing.isPaused) {
          throw new Error('TENANT_GLOBAL_PAUSED');
        }
        if (expectedTenantPauseGeneration !== undefined && existing.pauseGeneration !== expectedTenantPauseGeneration) {
          throw new Error('TENANT_GLOBAL_PAUSED_OR_GATE_MISMATCH');
        }
      } else {
        const settingsDoc: any = await CampaignSettingsModel.findOne({ tenantId }).session(session);
        if (settingsDoc && settingsDoc.isPaused === true) {
          throw new Error('TENANT_GLOBAL_PAUSED');
        }
        tenantGate = new TenantControlGateModel({
          tenantId,
          isPaused: false,
          pauseGeneration: 0,
          version: 2,
        });
        await tenantGate.save({ session });
      }
    }

    // 2. Lock/Conditional-Update Campaign Control Gate (Spec p25)
    let controlGate: any = await CampaignControlGateModel.findOneAndUpdate(
      {
        tenantId,
        campaignId,
        ...(expectedPauseGeneration !== undefined ? { pauseGeneration: expectedPauseGeneration } : {}),
      },
      { $inc: { version: 1 } },
      { session, new: true }
    );

    if (!controlGate) {
      const existing = await CampaignControlGateModel.findOne({ tenantId, campaignId }).session(session);
      if (existing) {
        if (expectedPauseGeneration !== undefined && existing.pauseGeneration !== expectedPauseGeneration) {
          throw new Error('PAUSE_GENERATION_MISMATCH');
        }
      } else {
        controlGate = new CampaignControlGateModel({
          tenantId,
          campaignId,
          pauseGeneration: expectedPauseGeneration || 0,
          version: 2,
        });
        await controlGate.save({ session });
      }
    }

    // 3. Lock/Update Destination Contact Gate (Spec p25)
    let gate: any = await CampaignContactGateModel.findOne({ tenantId, destinationHash }).session(session);

    if (!gate) {
      // Upsert new contact gate document
      gate = new CampaignContactGateModel({
        tenantId,
        destinationHash,
        version: 1,
        ledger: [],
      });
    }

    // Recheck capacity atomically within transaction
    const capCheck = await this.checkCapacity(
      tenantId,
      destinationHash,
      serverNow,
      settings,
      executionId, // safe retry re-reserves under same execution key without double counting
      purpose,
      session
    );

    if (!capCheck.allowed) {
      logger.warn(
        { tenantId, destinationHash, executionId, reason: capCheck.reason },
        'reserveContactCapacityAtomic: Capacity exceeded in transaction lock.'
      );
      throw new Error(`CONTACT_CAP_EXCEEDED:${capCheck.reason}`);
    }

    // Reserve capacity in rolling ledger: one entry per execution timestamped at reservation
    const existingIndex = gate.ledger.findIndex((e: any) => e.executionId === executionId);

    const newEntry: ICampaignContactLedgerEntry = {
      executionId,
      campaignId,
      purpose,
      reservedAt: serverNow,
      status: 'RESERVED',
      releasedAt: null,
      releaseReason: null,
      updatedAt: serverNow,
    };

    if (existingIndex >= 0) {
      // Safe retry re-reserves at the new attempt time under the same execution key without double counting
      gate.ledger[existingIndex] = newEntry;
    } else {
      gate.ledger.push(newEntry);
    }

    // Keep bounded rolling ledger: prune entries that are RELEASED or completed/aged out beyond 30 days
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const pruneCutoffMs = serverNow.getTime() - THIRTY_DAYS_MS;

    gate.ledger = gate.ledger.filter((entry: any) => {
      // Never prune unresolved in-flight reservations (Spec p18)
      if (entry.status === 'RESERVED') return true;
      // Prune released entries older than 24 hours
      if (entry.status === 'RELEASED') {
        const releasedTime = entry.releasedAt ? new Date(entry.releasedAt).getTime() : 0;
        return serverNow.getTime() - releasedTime < 24 * 60 * 60 * 1000;
      }
      // Prune older than 30 days
      return new Date(entry.reservedAt).getTime() > pruneCutoffMs;
    });

    gate.version += 1;
    await gate.save({ session });

    return gate;
  }

  /**
   * Releases an execution's reservation upon PROVEN non-acceptance (Spec p18).
   * "Only proven non-acceptance releases that attempt's reservation.
   * Lease expiry alone never releases an uncertain one.
   * A safe retry reserves again at the new attempt time under the same execution key."
   */
  async releaseReservation(
    tenantId: string,
    destinationHash: string,
    executionId: string,
    reason: string,
    session?: ClientSession
  ): Promise<boolean> {
    const query = CampaignContactGateModel.findOne({ tenantId, destinationHash });
    if (session) query.session(session);
    const gate: any = await query.exec();

    if (!gate || !gate.ledger) {
      return false;
    }

    const entry = gate.ledger.find((e: any) => e.executionId === executionId);
    if (!entry) {
      return false;
    }

    const now = clock.now();
    entry.status = 'RELEASED';
    entry.releasedAt = now;
    entry.releaseReason = reason;
    entry.updatedAt = now;
    gate.version += 1;

    if (session) {
      await gate.save({ session });
    } else {
      await gate.save();
    }

    logger.info(
      { tenantId, destinationHash, executionId, reason },
      'releaseReservation: Proven non-acceptance released reservation.'
    );

    return true;
  }

  /**
   * Marks a reservation as ACCEPTED when provider accepts submission.
   */
  async markAccepted(
    tenantId: string,
    destinationHash: string,
    executionId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const query = CampaignContactGateModel.findOne({ tenantId, destinationHash });
    if (session) query.session(session);
    const gate: any = await query.exec();

    if (!gate || !gate.ledger) return false;

    const entry = gate.ledger.find((e: any) => e.executionId === executionId);
    if (!entry) return false;

    const now = clock.now();
    entry.status = 'ACCEPTED';
    entry.updatedAt = now;
    gate.version += 1;

    if (session) {
      await gate.save({ session });
    } else {
      await gate.save();
    }

    return true;
  }

  /**
   * Marks a reservation as UNKNOWN on network timeout or ambiguous disconnect (C06).
   * Note: Does NOT release the reservation! Remains counting in the rolling window.
   */
  async markOutcomeUnknown(
    tenantId: string,
    destinationHash: string,
    executionId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const query = CampaignContactGateModel.findOne({ tenantId, destinationHash });
    if (session) query.session(session);
    const gate: any = await query.exec();

    if (!gate || !gate.ledger) return false;

    const entry = gate.ledger.find((e: any) => e.executionId === executionId);
    if (!entry) return false;

    const now = clock.now();
    entry.status = 'UNKNOWN';
    entry.updatedAt = now;
    gate.version += 1;

    if (session) {
      await gate.save({ session });
    } else {
      await gate.save();
    }

    return true;
  }

  /**
   * Sets destination health to UNDELIVERABLE (Meta error 131026 or staff mark).
   * Cancels ALL pending UNSENT executions for that destinationHash across campaigns.
   */
  async markUndeliverable(
    tenantId: string,
    destinationHash: string,
    reason: string = 'RECIPIENT_NOT_ON_WHATSAPP (131026)',
    source: 'PROVIDER_STATUS' | 'STAFF' | 'CUSTOMER_REPLY' = 'PROVIDER_STATUS'
  ): Promise<ICampaignContactGate> {
    const now = clock.now();
    const gate: any = await CampaignContactGateModel.findOneAndUpdate(
      { tenantId, destinationHash },
      {
        $set: {
          'health.status': 'UNDELIVERABLE',
          'health.reason': reason,
          'health.lastFailureAt': now,
          'health.source': source,
          'health.clearedAt': null,
        },
        $inc: { 'health.failureCount': 1, version: 1 },
      },
      { upsert: true, new: true }
    );

    // Cancel ALL pending UNSENT executions across all campaigns for this destinationHash
    // 1. Cancel executions directly matching destinationHash if stored
    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        destinationHash,
        state: {
          $in: [
            EXECUTION_STATE.SCHEDULED,
            EXECUTION_STATE.DEFERRED,
            EXECUTION_STATE.EVALUATING,
            EXECUTION_STATE.DISPATCHING,
          ],
        },
      },
      {
        $set: {
          state: EXECUTION_STATE.CANCELLED,
          cancellationReason: 'DESTINATION_UNDELIVERABLE',
          skipReason: 'DESTINATION_UNDELIVERABLE',
          cancelledAt: now,
        },
      }
    );

    // 2. Also locate customers sharing this destinationHash and cancel their active unsent executions
    try {
      const customers = await mockCustomerSource.listCustomers(tenantId);
      const matchingCustomerIds = customers.customers
        .filter((c) => c.destination?.destinationHash === destinationHash)
        .map((c) => c.customerId);

      if (matchingCustomerIds.length > 0) {
        const activeEnrollments = await CampaignEnrollmentModel.find({
          tenantId,
          customerId: { $in: matchingCustomerIds },
        }).lean();

        const enrollmentIds = activeEnrollments.map((e) => e.enrollmentId);

        if (enrollmentIds.length > 0) {
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: { $in: enrollmentIds },
              state: {
                $in: [
                  EXECUTION_STATE.SCHEDULED,
                  EXECUTION_STATE.DEFERRED,
                  EXECUTION_STATE.EVALUATING,
                  EXECUTION_STATE.DISPATCHING,
                ],
              },
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                cancellationReason: 'DESTINATION_UNDELIVERABLE',
                skipReason: 'DESTINATION_UNDELIVERABLE',
                cancelledAt: now,
              },
            }
          );
        }
      }
    } catch (err) {
      logger.error({ err, tenantId, destinationHash }, 'Error cancelling pending executions on undeliverable');
    }

    return gate;
  }

  /**
   * Clears destination health back to OK.
   */
  async clearHealth(
    tenantId: string,
    destinationHash: string
  ): Promise<ICampaignContactGate | null> {
    const now = clock.now();
    return CampaignContactGateModel.findOneAndUpdate(
      { tenantId, destinationHash },
      {
        $set: {
          'health.status': 'OK',
          'health.clearedAt': now,
        },
        $inc: { version: 1 },
      },
      { new: true }
    );
  }

  /**
   * Checks whether a destination is currently marked UNDELIVERABLE.
   * Clears only when customerVerifiedAt > lastFailureAt.
   */
  isHealthUndeliverable(
    gate: ICampaignContactGate | null | undefined,
    customerVerifiedAt?: Date | string | null
  ): boolean {
    if (!gate || !gate.health || gate.health.status !== 'UNDELIVERABLE') {
      return false;
    }

    // Health clears only when authoritative customer data shows the same destination
    // re-verified with verifiedAt later than lastFailureAt.
    if (
      customerVerifiedAt &&
      gate.health.lastFailureAt &&
      new Date(customerVerifiedAt).getTime() > new Date(gate.health.lastFailureAt).getTime()
    ) {
      return false;
    }

    return true;
  }

  /**
   * Clears destination health if customerVerifiedAt is later than lastFailureAt.
   */
  async clearHealthIfReverified(
    tenantId: string,
    destinationHash: string,
    customerVerifiedAt?: Date | string | null
  ): Promise<boolean> {
    const gate: any = await CampaignContactGateModel.findOne({ tenantId, destinationHash });
    if (!gate || !gate.health || gate.health.status !== 'UNDELIVERABLE') {
      return false;
    }
    if (
      customerVerifiedAt &&
      gate.health.lastFailureAt &&
      new Date(customerVerifiedAt).getTime() > new Date(gate.health.lastFailureAt).getTime()
    ) {
      await this.clearHealth(tenantId, destinationHash);
      return true;
    }
    return false;
  }
}

export const contactGateService = new ContactGateService();

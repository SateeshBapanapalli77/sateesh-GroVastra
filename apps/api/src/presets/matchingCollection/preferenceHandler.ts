/**
 * Matching Collection — Preference Change Handler (F26)
 *
 * When a customer updates their preferences (preference.changed event), we:
 *   1. Re-score their affinity against all active collection releases
 *   2. Any active collection enrollment where the customer now scores below
 *      the campaign minAffinityScore is cancelled (PREFERENCE_MISMATCH)
 *
 * NOTE: We do NOT retroactively enroll customers who become eligible after
 * a preference change (FUTURE_ONLY importPolicy). Only forward events trigger
 * new enrollments.
 */

import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  normalizePreferences,
} from '@grovastra/shared';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignVersionModel,
  ICampaignEventInbox,
} from '../../db/models';
import { SrcCustomerModel } from '../../db/models/src-customer.model';
import { SrcCollectionModel } from '../../db/models/src-collection.model';
import { scoreAffinityForCollection, evaluateAffinityEligibility } from './matching';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

/**
 * Called when `preference.changed` is received for a customer that has
 * active matching_collection enrollments.
 *
 * Returns a summary of cancelled enrollments (if any).
 */
export async function handlePreferenceChangedForCollection(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, customerId, occurredAt } = eventDoc;
  const now = occurredAt || clock.now();

  if (!customerId) {
    return { handler: 'preference.changed@collection', outcome: 'NO_CUSTOMER_ID' };
  }

  // Load active collection enrollments for this customer
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    occurrenceId: { $regex: '^collection:' },
    status: ENROLLMENT_STATUS.ACTIVE,
  });

  if (activeEnrollments.length === 0) {
    return { handler: 'preference.changed@collection', outcome: 'NO_ACTIVE_ENROLLMENTS' };
  }

  // Load current customer preferences
  const customer = (await SrcCustomerModel.findOne({ tenantId, customerId }).lean()) as any;
  if (!customer) {
    return { handler: 'preference.changed@collection', outcome: 'CUSTOMER_NOT_FOUND' };
  }

  const normalizedPrefs = normalizePreferences(customer.preferences as any);
  let cancelledCount = 0;

  for (const enrollment of activeEnrollments) {
    const releaseId = (enrollment as any).releaseId || enrollment.occurrenceId?.split(':')[1];
    if (!releaseId) continue;

    // Load the campaign version to get minAffinityScore
    const version = await CampaignVersionModel.findOne({
      tenantId,
      campaignId: enrollment.campaignId,
      version: enrollment.campaignVersion,
    }).lean();

    if (!version) continue;

    const minAffinityScore: number = (version as any).minAffinityScore ?? 0.0;
    // If campaign has no minimum threshold, nothing to re-evaluate
    if (minAffinityScore <= 0.0) continue;

    // Load the collection items
    const collection = (await SrcCollectionModel.findOne({ tenantId, releaseId }).lean()) as any;
    if (!collection || collection.status === 'WITHDRAWN') continue;

    const affinityResult = scoreAffinityForCollection(
      normalizedPrefs,
      collection.items as any,
      minAffinityScore
    );

    const eligibility = evaluateAffinityEligibility(affinityResult, minAffinityScore);

    if (!eligibility.eligible) {
      // Cancel this enrollment
      await CampaignEnrollmentModel.updateOne(
        { enrollmentId: enrollment.enrollmentId, tenantId },
        {
          $set: {
            status: ENROLLMENT_STATUS.CANCELLED,
            stopReason: 'PREFERENCE_MISMATCH',
            stoppedAt: now,
            matchExplanation: `Cancelled after preference update: ${eligibility.explanation}`,
          },
        }
      );

      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enrollment.enrollmentId,
          state: {
            $in: [
              EXECUTION_STATE.SCHEDULED,
              EXECUTION_STATE.DEFERRED,
            ],
          },
        },
        {
          $set: {
            state: EXECUTION_STATE.CANCELLED,
            skipReason: 'PREFERENCE_MISMATCH',
          },
        }
      );

      cancelledCount++;
      logger.info(
        { tenantId, customerId, enrollmentId: enrollment.enrollmentId, releaseId },
        '[F26] Enrollment cancelled due to preference change below threshold'
      );
    }
  }

  return {
    handler: 'preference.changed@collection',
    tenantId,
    customerId,
    checkedEnrollments: activeEnrollments.length,
    cancelledEnrollments: cancelledCount,
  };
}

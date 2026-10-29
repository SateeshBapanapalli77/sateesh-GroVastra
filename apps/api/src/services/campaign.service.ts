import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import {
  CampaignPreset,
  CampaignVersion,
  CAMPAIGN_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  CreateCampaignInputSchema,
  UpdateCampaignDraftInputSchema,
  PublishRevisionInputSchema,
} from '@grovastra/shared';
import { CampaignModel, ICampaign } from '../db/models/campaign.model';
import { CampaignVersionModel, ICampaignVersion } from '../db/models/campaign-version.model';
import { CampaignControlGateModel } from '../db/models/campaign-control-gate.model';
import { CampaignExecutionModel } from '../db/models/campaign-execution.model';
import { CampaignEnrollmentModel } from '../db/models/campaign-enrollment.model';
import { BranchModel } from '../db/models/branch.model';
import { campaignSettingsService } from './campaign-settings.service';
import { campaignValidationService } from './campaign-validation.service';
import { readinessService } from './readiness.service';
import { dryRunService, computeDraftFingerprint } from './dry-run.service';
import { mockTemplateSource } from '../adapters';
import { clock } from './clock';
import { auditService } from './audit.service';
import { plannerService } from './planner';
import { logger } from '../logger';
import { ValidationError, NotFoundError, ConflictError, AppError } from '../errors/app-error';
import {
  WELCOME_NEW_CUSTOMER_DEFINITION,
  WELCOME_NEW_CUSTOMER_ID,
  WELCOME_NEW_CUSTOMER_ALIAS,
} from '../presets/welcome/definition';
import {
  REQUESTED_ITEM_AVAILABLE_DEFINITION,
  REQUESTED_ITEM_AVAILABLE_ID,
  REQUESTED_ITEM_AVAILABLE_ALIAS,
} from '../presets/requestedItemAvailable/definition';
import {
  MATCHING_COLLECTION_DEFINITION,
  MATCHING_COLLECTION_ID,
  MATCHING_COLLECTION_ALIAS,
} from '../presets/matchingCollection/definition';
import {
  SELECTED_STOCK_PROMOTION_DEFINITION,
  SELECTED_STOCK_PROMOTION_ID,
  SELECTED_STOCK_PROMOTION_ALIAS,
} from '../presets/selectedStockPromotion/definition';

/**
 * Calculates nextEvaluationAt for campaign activation adhering to Spec p17, p29, p33:
 * - Aligns to tenant allowed sending hours in tenant timezone.
 * - If current time is within sending hours, evaluation starts immediately.
 * - If before window start, scheduled for today at start time.
 * - If after window end, scheduled for tomorrow at start time.
 * - Blackout dates and holidays advance to next valid business day.
 * - Earliest scheduled step dueAt is respected if in the future.
 */
export async function computeNextEvaluationAt(
  tenantId: string,
  effectiveNow: Date,
  earliestDueAt?: Date | null
): Promise<Date> {
  const settings = await campaignSettingsService.getSettings(tenantId);
  const timezone = settings.timezone || 'Asia/Kolkata';
  const sendingHours = settings.allowedSendingHours || { start: '10:00', end: '19:00' };
  const blackoutDates = new Set(settings.blackoutDates || []);
  const holidays = new Set((settings.holidays || []).map((h) => h.date));

  const [sH, sM] = sendingHours.start.split(':').map(Number);
  const [eH, eM] = sendingHours.end.split(':').map(Number);

  let currentDt = DateTime.fromJSDate(effectiveNow, { zone: timezone });
  const startToday = currentDt.set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
  const endToday = currentDt.set({ hour: eH, minute: eM, second: 0, millisecond: 0 });

  let candidateDt: DateTime;
  if (currentDt < startToday) {
    candidateDt = startToday;
  } else if (currentDt < endToday) {
    candidateDt = currentDt;
  } else {
    candidateDt = startToday.plus({ days: 1 });
  }

  // Advance past blackout dates and holidays
  while (blackoutDates.has(candidateDt.toISODate()!) || holidays.has(candidateDt.toISODate()!)) {
    candidateDt = candidateDt.plus({ days: 1 }).set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
  }

  const nextWindowUtc = candidateDt.toUTC().toJSDate();

  if (earliestDueAt && earliestDueAt.getTime() > effectiveNow.getTime()) {
    return new Date(Math.min(nextWindowUtc.getTime(), earliestDueAt.getTime()));
  }

  return nextWindowUtc;
}

export const CAMPAIGN_PRESETS: CampaignPreset[] = [
  {
    id: 'birthday',
    name: 'Birthday Celebration',
    description: 'Annual customer date. Occasion shopping and boutique gifts.',
    triggerFamily: 'ANNUAL_DATE',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'Birthday Shopping',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'ANNUAL_DATE',
        field: 'customer.birthday',
        leapDayPolicy: 'FEB_28',
      },
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      steps: [
        {
          stepId: 'invitation',
          stepName: 'Occasion Invitation',
          offsetDays: -14,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: null,
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'followup',
          stepName: 'Friendly Reminder',
          offsetDays: -7,
          localTime: '10:00',
          prerequisite: 'PREVIOUS_ACCEPTED',
          templateRef: null,
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'greeting',
          stepName: 'Birthday Greeting',
          offsetDays: 0,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: null,
          bindings: {},
          stopOnReply: false,
          stopOnGoal: false,
          maxLatenessMinutes: 120,
        },
      ],
      priority: 80,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  {
    id: 'anniversary',
    name: 'Anniversary Celebration',
    description: 'Customer-declared anniversary event. Help customers prepare in time.',
    triggerFamily: 'ANNUAL_DATE',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'Anniversary Celebration',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'ANNUAL_DATE',
        field: 'customer.event',
        leapDayPolicy: 'FEB_28',
      },
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      steps: [
        {
          stepId: 'invitation',
          stepName: 'Anniversary Invitation',
          offsetDays: -21,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: null,
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'followup',
          stepName: 'Preparation Follow-up',
          offsetDays: -7,
          localTime: '10:00',
          prerequisite: 'PREVIOUS_ACCEPTED',
          templateRef: null,
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'greeting',
          stepName: 'Anniversary Greeting',
          offsetDays: 0,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: null,
          bindings: {},
          stopOnReply: false,
          stopOnGoal: false,
          maxLatenessMinutes: 120,
        },
      ],
      priority: 80,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  {
    id: 'gift_wedding_reminder',
    name: 'Gift / Wedding Reminder',
    description: 'Customer-declared event date. Help customers prepare in time.',
    triggerFamily: 'CUSTOMER_DECLARED_EVENT',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'Wedding Shopping Reminder',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'CUSTOMER_EVENT_DATE',
        occasionKind: 'WEDDING',
        fulfillmentLeadDays: 21,
      },
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      steps: [
        {
          stepId: 'wedding_invite',
          stepName: 'Wedding Preparation Invite',
          offsetDays: -45,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_wedding_invite',
            revision: 1,
            language: 'en',
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'event.localDate' },
            '3': { source: 'shop.displayName' },
          },
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'wedding_followup',
          stepName: 'Wedding Preparation Follow-up',
          offsetDays: -21,
          localTime: '10:00',
          prerequisite: 'PREVIOUS_ACCEPTED',
          templateRef: {
            id: 'tpl_wedding_followup',
            revision: 1,
            language: 'en',
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'shop.displayName' },
            '3': { source: 'event.localDate' },
          },
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
      ],
      priority: 70,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  {
    id: 'gift_wedding',
    name: 'Gift / Wedding Reminder',
    description: 'Alias for the customer-declared event date reminder preset.',
    triggerFamily: 'CUSTOMER_DECLARED_EVENT',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'Wedding Shopping Reminder',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'CUSTOMER_EVENT_DATE',
        occasionKind: 'WEDDING',
        fulfillmentLeadDays: 21,
      },
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      steps: [],
      priority: 70,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  {
    id: 'festival',
    name: 'Festival / Exhibition',
    description: 'Owner-approved dated event. Seasonal shopping and store visits.',
    triggerFamily: 'OWNER_DATED_EVENT',
    implemented: false,
    category: 'MARKETING',
  },
  {
    id: 'unresolved_enquiry',
    name: 'Unresolved Enquiry',
    description: 'Enquiry event + elapsed time. Follow up before interest is lost.',
    triggerFamily: 'ENQUIRY_EVENT_DELAY',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'Unresolved Enquiry Follow-up',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'ENQUIRY_EVENT_DELAY',
        anchor: 'ENQUIRY_LAST_INTERACTION',
      },
      usefulForDays: 14,
      goalMode: 'ITEM_OR_TAGGED',
      requireItem: false,
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'ENQUIRY_PURCHASE' },
      steps: [
        {
          stepId: 'step_1',
          stepName: 'First Enquiry Follow-up',
          delay: { unit: 'HOURS', value: 24 },
          outsideHoursPolicy: 'DEFER_NEXT_DAY',
          maxDeferralHours: 24,
          maxLatenessMinutes: 720,
          stopOnReply: true,
          stopOnGoal: true,
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_enquiry_followup_item',
            language: 'en',
            revision: 1,
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'item.name', fallbackLiteral: 'the item you asked about' },
            '3': { source: 'shop.displayName' },
          },
        },
        {
          stepId: 'step_2',
          stepName: 'Second Enquiry Follow-up',
          delay: { unit: 'HOURS', value: 72 },
          outsideHoursPolicy: 'DEFER_NEXT_DAY',
          maxDeferralHours: 24,
          maxLatenessMinutes: 720,
          stopOnReply: true,
          stopOnGoal: true,
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_enquiry_followup_second',
            language: 'en',
            revision: 1,
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'shop.displayName' },
          },
        },
      ],
      priority: 55,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  // Note: 'enquiry' was a duplicate alias for 'unresolved_enquiry' — removed.
  // Note: 'requested_stock' was a placeholder stub — replaced by REQUESTED_ITEM_AVAILABLE_DEFINITION (F25).
  MATCHING_COLLECTION_DEFINITION as unknown as CampaignPreset,
  SELECTED_STOCK_PROMOTION_DEFINITION as unknown as CampaignPreset,
  {
    id: 'complete_the_outfit',
    name: 'Complete the Outfit',
    description: 'Qualifying purchase + delay. Relevant blouse/accessory/complement suggestions.',
    triggerFamily: 'ORDER_EVENT_DELAY',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'Complete the Outfit',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'ORDER_EVENT_DELAY',
        anchor: 'ORDER_COMPLETED_AT',
      },
      pairing: {
        anchorCategories: ['saree'],
        complementMap: {
          saree: ['blouse', 'petticoat', 'dupatta', 'accessories'],
          lehenga: ['dupatta', 'accessories'],
          kurta: ['dupatta', 'accessories'],
        },
        colourMatch: 'NEUTRAL_OR_SAME',
        requireSameWeave: false,
        budgetAware: false,
        alreadyOwnedLookbackDays: 180,
        suppressIfCategoryInOrder: true,
      },
      minDaysBetweenEnrollments: 30,
      goalMode: 'COMPLEMENT_OR_TAGGED',
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'COMPLEMENT_OR_TAGGED' },
      steps: [
        {
          stepId: 'step_1',
          stepName: 'Outfit Complement Suggestion',
          delay: { unit: 'DAYS', value: 5 },
          outsideHoursPolicy: 'DEFER_NEXT_DAY',
          maxDeferralHours: 24,
          maxLatenessMinutes: 1440,
          stopOnReply: true,
          stopOnGoal: true,
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_outfit_complete_one',
            language: 'en',
            revision: 1,
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'anchor.itemName' },
            '3': { source: 'complement.1.name' },
            '4': { source: 'shop.displayName' },
          },
        },
      ],
      priority: 35,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  // Note: 'outfit_completion' was a duplicate alias for 'complete_the_outfit' — removed.
  {
    id: 'first_to_second_purchase',
    name: 'First to Second Purchase',
    description: 'First qualifying order + delay. Encourage a useful repeat visit.',
    triggerFamily: 'QUALIFYING_ORDER',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'First to Second Purchase Bring-Back',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'EVENT_DELAY',
        anchor: 'FIRST_QUALIFYING_ORDER',
      },
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'SECOND_QUALIFYING_ORDER' },
      steps: [
        {
          stepId: 'step_1',
          stepName: 'Bring Back Reminder',
          delay: { unit: 'DAYS', value: 30 },
          outsideHoursPolicy: 'DEFER_NEXT_DAY',
          maxDeferralHours: 48,
          maxLatenessMinutes: 1440,
          stopOnReply: true,
          stopOnGoal: true,
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_repeat_visit_invite',
            language: 'en',
            revision: 1,
          },
          bindings: {
            '1': 'customer.firstName',
            '2': 'shop.displayName',
            '3': 'order.firstOrderDate',
          },
        },
        {
          stepId: 'step_2',
          stepName: 'Second Chance Follow-up',
          delay: { unit: 'DAYS', value: 45 },
          outsideHoursPolicy: 'DEFER_NEXT_DAY',
          maxDeferralHours: 48,
          maxLatenessMinutes: 1440,
          stopOnReply: true,
          stopOnGoal: true,
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_repeat_visit_invite',
            language: 'en',
            revision: 1,
          },
          bindings: {
            '1': 'customer.firstName',
            '2': 'shop.displayName',
            '3': 'order.firstOrderDate',
          },
        },
      ],
      priority: 40,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  {
    id: 'win_back',
    name: 'Customer Win-back',
    description: 'Category-specific inactivity threshold. Invite past customers back with a reason.',
    triggerFamily: 'INACTIVITY_THRESHOLD',
    implemented: true,
    category: 'MARKETING',
    defaults: {
      name: 'Customer Win-back',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'INACTIVITY_THRESHOLD',
        thresholdDays: 90,
        ruleId: 'default',
      },
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      steps: [
        {
          stepId: 'winback_invite',
          stepName: 'We Miss You Invitation',
          offsetDays: 0,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_winback_invite',
            revision: 1,
            language: 'en',
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'shop.displayName' },
          },
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
      ],
      priority: 30,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
    },
  },
  {
    id: 'vip_loyalty',
    name: 'VIP / Credit / Referral',
    description: 'Milestone, real expiry or completed order. Recognition and redemption.',
    triggerFamily: 'MILESTONE_EXPIRY',
    implemented: false,
    category: 'MARKETING',
  },
  {
    id: 'fitting_alteration',
    name: 'Fitting / Alteration',
    description: 'Appointment or production milestone. Keep boutique customers informed.',
    triggerFamily: 'PRODUCTION_MILESTONE',
    implemented: false,
    category: 'SERVICE',
  },
  {
    id: 'outfit_collection',
    name: 'Outfit Collection / Delivery',
    description: 'Actual fulfillment milestone. Reduce missed collections and status calls.',
    triggerFamily: 'FULFILLMENT_MILESTONE',
    implemented: false,
    category: 'SERVICE',
  },
  {
    id: 'stock_promotion',
    name: 'Selected-stock Promotion',
    description: 'Owner publishes valid stock offer. Match an offer to suitable customers.',
    triggerFamily: 'STOCK_OFFER',
    implemented: false,
    category: 'MARKETING',
  },
  WELCOME_NEW_CUSTOMER_DEFINITION,
  REQUESTED_ITEM_AVAILABLE_DEFINITION as CampaignPreset,
];

export class CampaignService {
  /**
   * Lists all catalogue presets with their implementation status.
   */
  listPresets(): CampaignPreset[] {
    const isMetaMode = (process.env.DISPATCH_MODE || '').toLowerCase() === 'meta';
    if (!isMetaMode) return CAMPAIGN_PRESETS;
    return CAMPAIGN_PRESETS.map((p) => {
      const isWelcome = p.id === WELCOME_NEW_CUSTOMER_ID || p.id === WELCOME_NEW_CUSTOMER_ALIAS;
      const isRepeat =
        p.id === 'FIRST_TO_SECOND_PURCHASE' ||
        p.id === 'first_to_second_purchase' ||
        p.id === 'second_purchase';

      if (isWelcome || isRepeat) {
        return {
          ...p,
          defaults: {
            ...p.defaults,
            steps: (p.defaults?.steps || []).map((step) => ({
              ...step,
              templateRef: {
                id: 'tpl_hello_world',
                revision: 1,
                language: 'en_US',
              },
              bindings: {},
            })),
          },
        };
      }
      return p;
    });
  }

  /**
   * Retrieves a single preset configuration by ID.
   */
  getPreset(presetId: string): CampaignPreset | undefined {
    const p = CAMPAIGN_PRESETS.find(
      (p) =>
        p.id === presetId ||
        p.id.toLowerCase() === presetId.toLowerCase() ||
        (presetId.toLowerCase() === 'welcome_new_customer' &&
          (p.id === WELCOME_NEW_CUSTOMER_ID || p.id === WELCOME_NEW_CUSTOMER_ALIAS)) ||
        ((presetId.toLowerCase() === 'second_purchase' ||
          presetId.toLowerCase() === 'first-repeat' ||
          presetId.toUpperCase() === 'FIRST_TO_SECOND_PURCHASE') &&
          (p.id === 'first_to_second_purchase' || p.id === 'second_purchase')) ||
        ((presetId.toLowerCase() === 'gift_wedding_reminder' ||
          presetId.toLowerCase() === 'gift_wedding' ||
          presetId.toLowerCase() === 'gift-wedding') &&
          (p.id === 'gift_wedding_reminder' || p.id === 'gift_wedding')) ||
        ((presetId.toLowerCase() === 'unresolved_enquiry' ||
          presetId.toLowerCase() === 'unresolved-enquiry' ||
          presetId.toLowerCase() === 'enquiry') &&
          (p.id === 'unresolved_enquiry' || p.id === 'enquiry')) ||
        ((presetId.toLowerCase() === 'complete_the_outfit' ||
          presetId.toLowerCase() === 'complete-outfit' ||
          presetId.toLowerCase() === 'complete-the-outfit' ||
          presetId.toLowerCase() === 'outfit_completion') &&
          (p.id === 'complete_the_outfit' || p.id === 'outfit_completion')) ||
        ((presetId.toLowerCase() === 'requested_item_available' ||
          presetId.toLowerCase() === 'requested-item-available' ||
          presetId.toLowerCase() === 'request_stock_available') &&
          (p.id === REQUESTED_ITEM_AVAILABLE_ID || p.id === REQUESTED_ITEM_AVAILABLE_ALIAS))
        ||
        ((presetId.toLowerCase() === SELECTED_STOCK_PROMOTION_ID ||
          presetId.toLowerCase() === SELECTED_STOCK_PROMOTION_ALIAS.toLowerCase() ||
          presetId.toLowerCase() === 'selected-stock-promotion') &&
          (p.id === SELECTED_STOCK_PROMOTION_ID || p.id === SELECTED_STOCK_PROMOTION_ALIAS))
    );
    if (!p) return undefined;

    const isMetaMode = (process.env.DISPATCH_MODE || '').toLowerCase() === 'meta';
    const isWelcome = p.id === WELCOME_NEW_CUSTOMER_ID || p.id === WELCOME_NEW_CUSTOMER_ALIAS;
    const isRepeat =
      p.id === 'FIRST_TO_SECOND_PURCHASE' ||
      p.id === 'first_to_second_purchase' ||
      p.id === 'second_purchase';

    if (isMetaMode && (isWelcome || isRepeat)) {
      return {
        ...p,
        defaults: {
          ...p.defaults,
          steps: (p.defaults?.steps || []).map((step) => ({
            ...step,
            templateRef: {
              id: 'tpl_hello_world',
              revision: 1,
              language: 'en_US',
            },
            bindings: {},
          })),
        },
      };
    }

    return p;
  }

  /**
   * Lists campaigns for a tenant.
   */
  async listCampaigns(tenantId: string): Promise<ICampaign[]> {
    return (await CampaignModel.find({ tenantId }).sort({ createdAt: -1 }).lean()) as any;
  }

  /**
   * Retrieves a single campaign with its active draft, active published version, and control gate.
   */
  async getCampaign(tenantId: string, campaignId: string) {
    const campaign = await CampaignModel.findOne({ tenantId, campaignId }).lean<ICampaign | null>();
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const draft = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
    }).lean<ICampaignVersion | null>();

    const activeVersion = campaign.activeVersionId
      ? await CampaignVersionModel.findOne({
          tenantId,
          campaignId,
          _id: campaign.activeVersionId,
        }).lean<ICampaignVersion | null>()
      : null;

    const versions = (await CampaignVersionModel.find({ tenantId, campaignId })
      .sort({ version: -1 })
      .lean()) as any[];

    const controlGate = (await CampaignControlGateModel.findOne({
      tenantId,
      campaignId,
    }).lean()) as any;

    return {
      campaign,
      draft,
      activeVersion,
      versions,
      controlGate: controlGate
        ? {
            pauseGeneration: controlGate.pauseGeneration,
            version: controlGate.version,
          }
        : { pauseGeneration: 0, version: 1 },
      oldVersionEnrollmentCounts: 0,
    };
  }

  /**
   * Lists all immutable versions and drafts for a campaign.
   */
  async listCampaignVersions(tenantId: string, campaignId: string) {
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }
    return CampaignVersionModel.find({ tenantId, campaignId }).sort({ version: -1 }).lean();
  }

  /**
   * Creates a new campaign in DRAFT status with initial version 1 and control gate.
   * Enforces Hard Rule 10 (unimplemented presets rejected).
   */
  async createDraft(params: {
    tenantId: string;
    userId: string;
    input: unknown;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, input, ip, userAgent } = params;

    if ((input as any)?.triggerMode !== undefined) {
      const err = new AppError('Field triggerMode is no longer supported', 422, 'UNPROCESSABLE_ENTITY', { fieldPath: 'triggerMode' });
      (err as any).fieldPath = 'triggerMode';
      throw err;
    }

    const pid = String((input as any)?.presetId || '').toUpperCase();
    if (pid.includes('FIRST') && pid.includes('VISIT')) {
      const err = new AppError('Legacy visit preset is no longer supported', 422, 'UNPROCESSABLE_ENTITY', { fieldPath: 'presetId' });
      (err as any).fieldPath = 'presetId';
      throw err;
    }

    const parsed = CreateCampaignInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0].message, parsed.error.format());
    }

    const { presetId, name, enabledBranches: rawBranches } = parsed.data;

    // 1. Hard Rule 10: Reject unimplemented presets
    const preset = this.getPreset(presetId);
    if (!preset || !preset.implemented) {
      throw new ValidationError(
        `Preset '${presetId}' evaluator is not yet implemented (Hard Rule 10, Spec p5)`
      );
    }

    // 2. Validate Branch Scope
    const activeTenantBranches = await BranchModel.find({ tenantId, status: 'active' }).lean();
    const activeBranchIds = activeTenantBranches.map((b) => b.branchId);

    let enabledBranches: string[];
    if (rawBranches && rawBranches.length > 0) {
      for (const bId of rawBranches) {
        if (!activeBranchIds.includes(bId)) {
          throw new ValidationError(
            `Unauthorized or invalid branch reference '${bId}' in tenant scope`
          );
        }
      }
      enabledBranches = rawBranches;
    } else {
      enabledBranches = activeBranchIds;
    }

    // 3. Inherit Tenant Timezone & Priority Defaults
    const tenantSettings = await campaignSettingsService.getSettings(tenantId);
    const timezone = tenantSettings.timezone || 'Asia/Kolkata';

    // 4. Generate unique campaignId
    const randomSuffix = Math.random().toString(36).substring(2, 7);
    const campaignId = `cmp_${presetId}_${Date.now()}_${randomSuffix}`;

    // 5. Build Initial Version Defaults from Preset
    const defaults = preset.defaults || {};

    const campaign = new CampaignModel({
      campaignId,
      tenantId,
      name,
      presetId,
      status: CAMPAIGN_STATUS.DRAFT,
      activeVersionId: null,
      draftVersion: 1,
      pauseGeneration: 0,
      enabledBranches,
      startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : (defaults as any).startAt ? new Date((defaults as any).startAt) : null,
      endAt: (input as any)?.endAt ? new Date((input as any).endAt) : null,
    });

    const draft = new CampaignVersionModel({
      tenantId,
      campaignId,
      version: 1,
      name,
      industry: defaults.industry || 'BOUTIQUE',
      purpose: defaults.purpose || 'MARKETING',
      trigger: defaults.trigger || {
        type: 'ANNUAL_DATE',
        field: 'customer.birthday',
        leapDayPolicy: 'FEB_28',
      },
      timezone,
      audience: defaults.audience || { mode: 'ALL_ELIGIBLE' },
      goal: defaults.goal || { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      steps: defaults.steps || [],
      priority: defaults.priority || 80,
      resumePolicy: defaults.resumePolicy || 'FUTURE_ONLY',
      importPolicy: defaults.importPolicy || 'FUTURE_ONLY',
      enabledBranches,
      startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : (defaults as any).startAt ? new Date((defaults as any).startAt) : null,
      scope: parsed.data.scope || (defaults as any).scope || 'PER_CUSTOMER',
      schemaVersion: parsed.data.schemaVersion || (defaults as any).schemaVersion || 2,
      minFirstOrderNetPaise: parsed.data.minFirstOrderNetPaise !== undefined ? parsed.data.minFirstOrderNetPaise : ((defaults as any).minFirstOrderNetPaise ?? 0),
    });

    const controlGate = new CampaignControlGateModel({
      tenantId,
      campaignId,
      pauseGeneration: 0,
      version: 1,
    });

    await campaign.save();
    await draft.save();
    await controlGate.save();

    // 6. Log append-only audit trail
    await auditService.logEvent({
      tenantId,
      userId,
      action: 'CAMPAIGN_DRAFT_CREATED',
      metadata: {
        campaignId,
        presetId,
        name,
        enabledBranches,
      },
      ip,
      userAgent,
    });

    return {
      campaign: campaign.toObject(),
      draft: draft.toObject(),
      draftVersion: draft.toObject(),
    };
  }

  /**
   * Updates an existing campaign draft with optimistic concurrency locking (expectedVersion).
   * Returns 409 Conflict on stale version (spec p26, C16).
   */
  async updateDraft(params: {
    tenantId: string;
    userId: string;
    campaignId: string;
    input: unknown;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, campaignId, input, ip, userAgent } = params;

    if ((input as any)?.triggerMode !== undefined) {
      const err = new AppError('Field triggerMode is no longer supported', 422, 'UNPROCESSABLE_ENTITY', { fieldPath: 'triggerMode' });
      (err as any).fieldPath = 'triggerMode';
      throw err;
    }

    const parsed = UpdateCampaignDraftInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0].message, parsed.error.format());
    }

    const { expectedVersion, ...data } = parsed.data;

    // 1. Locate campaign
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    // 2. Locate active draft
    const draft = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
    });

    if (!draft) {
      throw new NotFoundError(
        `Campaign draft version ${campaign.draftVersion} not found for campaign '${campaignId}'`
      );
    }

    // 3. Optimistic Concurrency Check (spec p26, C16)
    if (draft.version !== expectedVersion) {
      throw new ConflictError(
        `Campaign draft version conflict: expected version ${expectedVersion}, but current version is ${draft.version}`,
        { expectedVersion, currentVersion: draft.version }
      );
    }

    // 4. Validate branch scope if updated
    if (data.enabledBranches) {
      const activeTenantBranches = await BranchModel.find({ tenantId, status: 'active' }).lean();
      const activeBranchIds = activeTenantBranches.map((b) => b.branchId);
      for (const bId of data.enabledBranches) {
        if (!activeBranchIds.includes(bId)) {
          throw new ValidationError(
            `Unauthorized or invalid branch reference '${bId}' in tenant scope`
          );
        }
      }
    }

    // 5. Apply updates
    const nextVersion = draft.version + 1;
    let targetDraft: any;

    if (draft.isPublished) {
      // Editing an active / published campaign:
      // Create new working draft version N+1. Published version N keeps running untouched (Spec p9, B14).
      targetDraft = new CampaignVersionModel({
        tenantId,
        campaignId,
        version: nextVersion,
        name: data.name !== undefined ? data.name : draft.name,
        industry: draft.industry,
        purpose: draft.purpose,
        trigger: data.trigger !== undefined ? data.trigger : draft.trigger,
        timezone: data.timezone !== undefined ? data.timezone : draft.timezone,
        audience: data.audience !== undefined ? data.audience : draft.audience,
        goal: data.goal !== undefined ? data.goal : draft.goal,
        steps: data.steps !== undefined ? data.steps : draft.steps,
        priority: data.priority !== undefined ? data.priority : draft.priority,
        resumePolicy: data.resumePolicy !== undefined ? data.resumePolicy : draft.resumePolicy,
        importPolicy: data.importPolicy !== undefined ? data.importPolicy : draft.importPolicy,
        enabledBranches:
          data.enabledBranches !== undefined ? data.enabledBranches : draft.enabledBranches,
        startAt: data.startAt !== undefined ? (data.startAt ? new Date(data.startAt) : null) : draft.startAt,
        scope: data.scope !== undefined ? data.scope : draft.scope,
        schemaVersion: data.schemaVersion !== undefined ? data.schemaVersion : draft.schemaVersion,
        minFirstOrderNetPaise: data.minFirstOrderNetPaise !== undefined ? data.minFirstOrderNetPaise : draft.minFirstOrderNetPaise,
        isPublished: false,
        activatedBy: null,
        activatedAt: null,
        reviewFingerprint: null,
        nextEvaluationAt: null,
      });

      await targetDraft.save();
    } else {
      // Modifying an unpublished working draft
      if (data.name !== undefined) draft.name = data.name;
      if (data.enabledBranches !== undefined) draft.enabledBranches = data.enabledBranches;
      if (data.timezone !== undefined) draft.timezone = data.timezone;
      if (data.trigger !== undefined) draft.trigger = data.trigger;
      if (data.audience !== undefined) draft.audience = data.audience;
      if (data.goal !== undefined) draft.goal = data.goal;
      if (data.steps !== undefined) draft.steps = data.steps;
      if (data.priority !== undefined) draft.priority = data.priority;
      if (data.resumePolicy !== undefined) draft.resumePolicy = data.resumePolicy;
      if (data.importPolicy !== undefined) draft.importPolicy = data.importPolicy;
      if (data.startAt !== undefined) draft.startAt = data.startAt ? new Date(data.startAt) : null;
      if (data.scope !== undefined) draft.scope = data.scope;
      if (data.schemaVersion !== undefined) draft.schemaVersion = data.schemaVersion;
      if (data.minFirstOrderNetPaise !== undefined) draft.minFirstOrderNetPaise = data.minFirstOrderNetPaise;

      draft.version = nextVersion;
      await draft.save();
      targetDraft = draft;
    }

    // Sync campaign document
    campaign.draftVersion = nextVersion;
    if (data.name !== undefined) campaign.name = data.name;
    if (data.enabledBranches !== undefined) campaign.enabledBranches = data.enabledBranches;
    if (data.startAt !== undefined) campaign.startAt = data.startAt ? new Date(data.startAt) : null;
    if (data.endAt !== undefined) campaign.endAt = data.endAt ? new Date(data.endAt) : null;
    await campaign.save();

    // 6. Log audit event
    await auditService.logEvent({
      tenantId,
      userId,
      action: draft.isPublished ? 'CAMPAIGN_DRAFT_REVISION_CREATED' : 'CAMPAIGN_DRAFT_UPDATED',
      metadata: {
        campaignId,
        previousVersion: expectedVersion,
        newVersion: nextVersion,
      },
      ip,
      userAgent,
    });

    return {
      campaign: campaign.toObject(),
      draft: targetDraft.toObject(),
    };
  }

  /**
   * Validates current campaign draft and updates status to VALIDATED if error-free.
   */
  async validateDraft(tenantId: string, campaignId: string) {
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const draft = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
    }).lean<ICampaignVersion | null>();

    if (!draft) {
      throw new NotFoundError(
        `Campaign draft version ${campaign.draftVersion} not found for campaign '${campaignId}'`
      );
    }

    const report = await campaignValidationService.validateDraft(tenantId, draft as any);

    // Update status if errors are resolved
    if (report.valid) {
      if (campaign.status === CAMPAIGN_STATUS.DRAFT) {
        campaign.status = CAMPAIGN_STATUS.VALIDATED;
        await campaign.save();
      }
    } else {
      if (campaign.status === CAMPAIGN_STATUS.VALIDATED) {
        campaign.status = CAMPAIGN_STATUS.DRAFT;
        await campaign.save();
      }
    }

    return report;
  }

  /**
   * Activates a reviewed valid campaign draft (Feature 7, Spec p9, p20, p25, A02-A05, C15).
   * - Validates draft configuration
   * - Requires dry run matching current draft fingerprint
   * - Blocks on integration readiness, unusable template, or broken binding sources (A05)
   * - Dummy templates: blocks activation in DISPATCH_MODE=meta; warning in DISPATCH_MODE=dry
   * - Zero matches = warning only (A04)
   * - In ONE transaction: freezes immutable campaignVersion, sets activeVersionId, status ACTIVE
   * - Returns next evaluation instant, NEVER "sent"
   */
  async activateCampaign(params: {
    tenantId: string;
    userId: string;
    campaignId: string;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, campaignId, ip, userAgent } = params;

    // 1. Locate campaign
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    // 2. Locate current draft
    const draft = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
    });
    if (!draft) {
      throw new NotFoundError(
        `Campaign draft version ${campaign.draftVersion} not found for campaign '${campaignId}'`
      );
    }

    // C15 Check: Duplicate click or React refresh returns existing active operation
    if (
      campaign.status === CAMPAIGN_STATUS.ACTIVE &&
      campaign.activeVersionId === draft._id.toString() &&
      draft.isPublished
    ) {
      return {
        campaign: campaign.toObject(),
        activeVersion: draft.toObject(),
        nextEvaluationAt: draft.nextEvaluationAt || clock.now(),
        message: 'Campaign is already active. Next evaluation scheduled.',
        warnings: [],
      };
    }

    // If campaign is already active but draft has been edited to N+1, route to publishRevision
    if (campaign.status === CAMPAIGN_STATUS.ACTIVE && !draft.isPublished) {
      return this.publishRevision({
        tenantId,
        userId,
        campaignId,
        expectedVersion: draft.version,
        ip,
        userAgent,
      });
    }

    // 3. Comprehensive Draft Validation (Spec p7-8, p20, A05)
    const report = await campaignValidationService.validateDraft(tenantId, draft as any);
    if (!report.valid) {
      throw new ValidationError(
        `Campaign draft validation failed with ${report.errors.length} error(s). Resolve all errors before activation.`,
        report.errors
      );
    }

    // 4. Integration Readiness Check (Spec p3, p7, p26, A05)
    const readiness = await readinessService.getTenantReadiness(tenantId);
    if (!readiness.ready) {
      const readinessErrors = readiness.failures.map((f) => ({
        fieldPath: 'integration',
        message: f.message,
        resolutionOwner: f.fixOwner,
      }));
      throw new ValidationError(
        'Integration readiness check failed. WhatsApp connection, tokens, and templates must be ready before activation.',
        readinessErrors
      );
    }

    // 5. Dummy Template Rule (Spec p8, F7)
    // A step using a template with sendable=false BLOCKS activation when DISPATCH_MODE=meta.
    // When DISPATCH_MODE=dry it is allowed with visible warning "dry mode: this campaign cannot send real messages".
    const dummyWarnings: string[] = [];
    const dispatchMode = (process.env.DISPATCH_MODE || 'dry').toLowerCase();

    for (let i = 0; i < (draft.steps || []).length; i++) {
      const step = draft.steps[i];
      if (step.templateRef?.id) {
        const template = await mockTemplateSource.getTemplateById(step.templateRef.id);
        if (template && !template.sendable) {
          if (dispatchMode === 'meta') {
            throw new ValidationError(
              `Activation blocked: step '${step.stepName || step.stepId}' references dummy template '${template.name}' with sendable=false in DISPATCH_MODE=meta`,
              [
                {
                  fieldPath: `steps[${i}].templateRef`,
                  message: `Dummy template '${template.name}' cannot be activated when DISPATCH_MODE=meta (sendable=false). Real sends require approved sendable templates.`,
                  resolutionOwner: 'INTEGRATION_DEVELOPER',
                },
              ]
            );
          } else {
            dummyWarnings.push('dry mode: this campaign cannot send real messages');
          }
        }
      }
    }

    // 6. Dry Run Verification (Spec p8, p20, p26, A03)
    const currentFingerprint = computeDraftFingerprint(draft);
    const latestDryRun = await dryRunService.getLatestDryRun(tenantId, campaignId);

    if (!latestDryRun) {
      throw new ValidationError(
        'Activation requires a dry run simulation report. Please run a dry run before activating.',
        [
          {
            fieldPath: 'dryRun',
            message: 'No dry run simulation report found for this campaign. A dry run is required before activation.',
            resolutionOwner: 'BOUTIQUE_OWNER',
          },
        ]
      );
    }

    if (latestDryRun.draftFingerprint !== currentFingerprint || latestDryRun.isStale) {
      throw new ValidationError(
        'Activation rejected: draft configuration has changed after the last dry run simulation (fingerprint mismatch). A new dry run is required.',
        [
          {
            fieldPath: 'draft',
            message: 'Draft fingerprint mismatch with latest dry run report. Re-run dry run simulation before activation.',
            resolutionOwner: 'BOUTIQUE_OWNER',
          },
        ]
      );
    }

    // 7. Zero Current Matches Warning (Spec p8, A04)
    const warnings: string[] = [...new Set(dummyWarnings)];
    if (latestDryRun.counts && latestDryRun.counts.eligible === 0) {
      warnings.push(
        'Zero eligible customers matched current evaluation. Campaign activated; future customers will be evaluated automatically.'
      );
    }

    // 8. Compute nextEvaluationAt
    const effectiveNow = clock.now();
    let earliestDueAt: Date | null = null;
    if (latestDryRun.samplePlans && latestDryRun.samplePlans.length > 0) {
      for (const sp of latestDryRun.samplePlans) {
        for (const st of sp.steps || []) {
          if (st.dueAtUtc) {
            const due = new Date(st.dueAtUtc);
            if (due.getTime() > effectiveNow.getTime()) {
              if (!earliestDueAt || due.getTime() < earliestDueAt.getTime()) {
                earliestDueAt = due;
              }
            }
          }
        }
      }
    }

    const nextEvaluationAt = await computeNextEvaluationAt(tenantId, effectiveNow, earliestDueAt);

    // 9. Transactional Boundary (Spec p25)
    // In ONE transaction: freeze immutable campaignVersion, set activeVersionId, status ACTIVE.
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      // Freeze immutable campaignVersion
      draft.isPublished = true;
      draft.activatedBy = userId;
      draft.activatedAt = effectiveNow;
      draft.reviewFingerprint = currentFingerprint;
      draft.nextEvaluationAt = nextEvaluationAt;
      await draft.save({ session });

      // Update campaign
      campaign.status = CAMPAIGN_STATUS.ACTIVE;
      campaign.activeVersionId = draft._id.toString();
      campaign.activatedAt = campaign.activatedAt || effectiveNow;
      await campaign.save({ session });

      // Update control gate version
      await CampaignControlGateModel.findOneAndUpdate(
        { tenantId, campaignId },
        { $set: { version: draft.version } },
        { session, upsert: true }
      );

      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      throw txErr;
    } finally {
      await session.endSession();
    }

    // 10. Audit log
    await auditService.logEvent({
      tenantId,
      userId,
      action: 'CAMPAIGN_ACTIVATED',
      metadata: {
        campaignId,
        version: draft.version,
        activeVersionId: draft._id.toString(),
        reviewFingerprint: currentFingerprint,
        nextEvaluationAt: nextEvaluationAt.toISOString(),
      },
    });

    // 11. Initial Calendar Planner Run (Spec p17: "also triggered on activation")
    try {
      await plannerService.planCampaign(tenantId, campaignId);
    } catch (planErr) {
      logger.error({ planErr, campaignId, tenantId }, 'Initial campaign planning encountered an error');
    }

    const formattedNext = nextEvaluationAt.toISOString();

    return {
      campaign: campaign.toObject(),
      activeVersion: draft.toObject(),
      nextEvaluationAt,
      message: `Campaign activated successfully. Next evaluation scheduled for ${formattedNext}.`,
      warnings,
    };
  }

  /**
   * Publishes a new immutable revision N+1 for an active campaign (Feature 7, Spec p9, p20, p25, B14).
   * Existing enrollments retain version N; new enrollments will use N+1.
   */
  async publishRevision(params: {
    tenantId: string;
    userId: string;
    campaignId: string;
    expectedVersion?: number;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, campaignId, expectedVersion, ip, userAgent } = params;

    // 1. Locate campaign
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    // 2. Locate current draft
    const draft = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
    });
    if (!draft) {
      throw new NotFoundError(
        `Campaign draft version ${campaign.draftVersion} not found for campaign '${campaignId}'`
      );
    }

    // Optimistic concurrency check (C16)
    if (expectedVersion !== undefined && draft.version !== expectedVersion) {
      throw new ConflictError(
        `Campaign draft version conflict: expected version ${expectedVersion}, but current version is ${draft.version}`,
        { expectedVersion, currentVersion: draft.version }
      );
    }

    // If draft is already published, no unreleased revision exists
    if (draft.isPublished) {
      throw new ValidationError(
        'Campaign draft is already published. Edit the campaign to create draft N+1 before publishing revision.',
        [
          {
            fieldPath: 'draft',
            message:
              'Draft version is already published. Edit the campaign to create draft N+1 before publishing revision.',
            resolutionOwner: 'BOUTIQUE_OWNER',
          },
        ]
      );
    }

    // 3. Comprehensive Draft Validation
    const report = await campaignValidationService.validateDraft(tenantId, draft as any);
    if (!report.valid) {
      throw new ValidationError(
        `Campaign draft validation failed with ${report.errors.length} error(s). Resolve all errors before publishing revision.`,
        report.errors
      );
    }

    // 4. Integration Readiness Check
    const readiness = await readinessService.getTenantReadiness(tenantId);
    if (!readiness.ready) {
      const readinessErrors = readiness.failures.map((f) => ({
        fieldPath: 'integration',
        message: f.message,
        resolutionOwner: f.fixOwner,
      }));
      throw new ValidationError(
        'Integration readiness check failed. WhatsApp connection, tokens, and templates must be ready before publishing.',
        readinessErrors
      );
    }

    // 5. Dummy Template Rule
    const dummyWarnings: string[] = [];
    const dispatchMode = (process.env.DISPATCH_MODE || 'dry').toLowerCase();

    for (let i = 0; i < (draft.steps || []).length; i++) {
      const step = draft.steps[i];
      if (step.templateRef?.id) {
        const template = await mockTemplateSource.getTemplateById(step.templateRef.id);
        if (template && !template.sendable) {
          if (dispatchMode === 'meta') {
            throw new ValidationError(
              `Publish revision blocked: step '${step.stepName || step.stepId}' references dummy template '${template.name}' with sendable=false in DISPATCH_MODE=meta`,
              [
                {
                  fieldPath: `steps[${i}].templateRef`,
                  message: `Dummy template '${template.name}' cannot be activated when DISPATCH_MODE=meta (sendable=false). Real sends require approved sendable templates.`,
                  resolutionOwner: 'INTEGRATION_DEVELOPER',
                },
              ]
            );
          } else {
            dummyWarnings.push('dry mode: this campaign cannot send real messages');
          }
        }
      }
    }

    // 6. Dry Run Verification
    const currentFingerprint = computeDraftFingerprint(draft);
    const latestDryRun = await dryRunService.getLatestDryRun(tenantId, campaignId);

    if (!latestDryRun) {
      throw new ValidationError(
        'Publish revision requires a dry run simulation report. Please run a dry run before publishing.',
        [
          {
            fieldPath: 'dryRun',
            message: 'No dry run simulation report found for this revision. Run a dry run first.',
            resolutionOwner: 'BOUTIQUE_OWNER',
          },
        ]
      );
    }

    if (latestDryRun.draftFingerprint !== currentFingerprint || latestDryRun.isStale) {
      throw new ValidationError(
        'Publish revision rejected: draft configuration has changed after the last dry run simulation (fingerprint mismatch). A new dry run is required.',
        [
          {
            fieldPath: 'draft',
            message: 'Draft fingerprint mismatch with latest dry run report. Re-run dry run simulation before publishing revision.',
            resolutionOwner: 'BOUTIQUE_OWNER',
          },
        ]
      );
    }

    // 7. Zero Current Matches Warning (A04)
    const warnings: string[] = [...new Set(dummyWarnings)];
    if (latestDryRun.counts && latestDryRun.counts.eligible === 0) {
      warnings.push(
        'Zero eligible customers matched current evaluation. Campaign revision published; future customers will be evaluated automatically.'
      );
    }

    // 8. Compute nextEvaluationAt
    const effectiveNow = clock.now();
    let earliestDueAt: Date | null = null;
    if (latestDryRun.samplePlans && latestDryRun.samplePlans.length > 0) {
      for (const sp of latestDryRun.samplePlans) {
        for (const st of sp.steps || []) {
          if (st.dueAtUtc) {
            const due = new Date(st.dueAtUtc);
            if (due.getTime() > effectiveNow.getTime()) {
              if (!earliestDueAt || due.getTime() < earliestDueAt.getTime()) {
                earliestDueAt = due;
              }
            }
          }
        }
      }
    }

    const nextEvaluationAt = await computeNextEvaluationAt(tenantId, effectiveNow, earliestDueAt);

    // 9. Transactional Boundary (Spec p25)
    // Freeze revision N+1, update activeVersionId to N+1. Version N remains pinned and untouched (Spec p9, B14).
    const previousActiveVersionId = campaign.activeVersionId;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      // Freeze immutable campaignVersion
      draft.isPublished = true;
      draft.activatedBy = userId;
      draft.activatedAt = effectiveNow;
      draft.reviewFingerprint = currentFingerprint;
      draft.nextEvaluationAt = nextEvaluationAt;
      await draft.save({ session });

      // Update campaign pointer
      campaign.status = CAMPAIGN_STATUS.ACTIVE;
      campaign.activeVersionId = draft._id.toString();
      await campaign.save({ session });

      // Update control gate version
      await CampaignControlGateModel.findOneAndUpdate(
        { tenantId, campaignId },
        { $set: { version: draft.version } },
        { session, upsert: true }
      );

      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      throw txErr;
    } finally {
      await session.endSession();
    }

    // 10. Audit log
    await auditService.logEvent({
      tenantId,
      userId,
      action: 'CAMPAIGN_REVISION_PUBLISHED',
      metadata: {
        campaignId,
        previousActiveVersionId,
        newActiveVersionId: draft._id.toString(),
        version: draft.version,
        reviewFingerprint: currentFingerprint,
        nextEvaluationAt: nextEvaluationAt.toISOString(),
      },
      ip,
    });

    // 11. Trigger Calendar Planner Run (Spec p17)
    try {
      await plannerService.planCampaign(tenantId, campaignId);
    } catch (planErr) {
      logger.error({ planErr, campaignId, tenantId }, 'Revision campaign planning encountered an error');
    }

    const formattedNext = nextEvaluationAt.toISOString();

    return {
      campaign: campaign.toObject(),
      activeVersion: draft.toObject(),
      nextEvaluationAt,
      message: `Campaign revision published successfully. Next evaluation scheduled for ${formattedNext}. New enrollments will use version ${draft.version}.`,
      warnings,
    };
  }

  /**
   * Generates a preview of affected execution and enrollment counts before pausing a campaign.
   */
  async getPausePreview(tenantId: string, campaignId: string) {
    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const [scheduledCount, inProgressCount, activeEnrollmentsCount] = await Promise.all([
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
      }),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.EVALUATING, EXECUTION_STATE.DISPATCHING] },
      }),
      CampaignEnrollmentModel.countDocuments({
        tenantId,
        campaignId,
        status: 'ACTIVE',
      }),
    ]);

    return {
      campaignId,
      currentStatus: campaign.status,
      affectedCounts: {
        scheduledCount,
        inProgressCount,
        activeEnrollmentsCount,
      },
      honestMessage: 'Messages already being sent may still go out.',
      notice: 'Pausing stops new enrollments and new submissions while retaining future schedules.',
    };
  }

  /**
   * Pauses an active campaign.
   * Conforms strictly to Spec p9, p20, p25, p29, B11, B12:
   * - Stops new enrollments and new submissions.
   * - Increments campaign and control-gate pauseGeneration in a single transaction.
   * - Retains scheduled executions and shows in-progress submissions separately.
   * - UI / API honestly reports: "Messages already being sent may still go out."
   */
  async pauseCampaign(params: {
    tenantId: string;
    userId: string;
    campaignId: string;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, campaignId, ip, userAgent } = params;

    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    if (campaign.status === CAMPAIGN_STATUS.ARCHIVED) {
      throw new ValidationError('Cannot pause an archived campaign');
    }

    // Idempotent if already PAUSED
    if (campaign.status === CAMPAIGN_STATUS.PAUSED) {
      const preview = await this.getPausePreview(tenantId, campaignId);
      return {
        campaign: campaign.toObject(),
        status: CAMPAIGN_STATUS.PAUSED,
        pauseGeneration: campaign.pauseGeneration,
        affectedCounts: preview.affectedCounts,
        honestMessage: 'Messages already being sent may still go out.',
        message: 'Campaign is already paused.',
      };
    }

    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      campaign.pauseGeneration = (campaign.pauseGeneration || 0) + 1;
      campaign.status = CAMPAIGN_STATUS.PAUSED;
      await campaign.save({ session });

      await CampaignControlGateModel.findOneAndUpdate(
        { tenantId, campaignId },
        {
          $set: { pauseGeneration: campaign.pauseGeneration },
          $inc: { version: 1 },
        },
        { session, upsert: true }
      );

      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      throw txErr;
    } finally {
      await session.endSession();
    }

    const preview = await this.getPausePreview(tenantId, campaignId);

    await auditService.logEvent({
      tenantId,
      userId,
      action: 'CAMPAIGN_PAUSED',
      metadata: {
        campaignId,
        pauseGeneration: campaign.pauseGeneration,
        affectedCounts: preview.affectedCounts,
      },
      ip,
      userAgent,
    });

    return {
      campaign: campaign.toObject(),
      status: CAMPAIGN_STATUS.PAUSED,
      pauseGeneration: campaign.pauseGeneration,
      affectedCounts: preview.affectedCounts,
      honestMessage: 'Messages already being sent may still go out.',
      message: `Campaign paused successfully. ${preview.affectedCounts.scheduledCount} scheduled steps held; ${preview.affectedCounts.inProgressCount} in-flight submissions may complete.`,
    };
  }

  /**
   * Generates preview of affected execution and enrollment counts before resuming a campaign.
   */
  async getResumePreview(tenantId: string, campaignId: string) {
    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const effectiveNow = clock.now();

    const [scheduledExecutions, inProgressCount, activeEnrollmentsCount] = await Promise.all([
      CampaignExecutionModel.find({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
      }).lean(),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.EVALUATING, EXECUTION_STATE.DISPATCHING] },
      }),
      CampaignEnrollmentModel.countDocuments({
        tenantId,
        campaignId,
        status: 'ACTIVE',
      }),
    ]);

    let futureCount = 0;
    let overdueCount = 0;

    for (const exe of scheduledExecutions) {
      const dueTime = new Date(exe.dueAt).getTime();
      const expiresTime = exe.expiresAt ? new Date(exe.expiresAt).getTime() : Infinity;
      if (dueTime <= effectiveNow.getTime() || expiresTime <= effectiveNow.getTime()) {
        overdueCount++;
      } else {
        futureCount++;
      }
    }

    return {
      campaignId,
      currentStatus: campaign.status,
      policy: 'FUTURE_ONLY',
      affectedCounts: {
        futureCount,
        overdueCount,
        inProgressCount,
        activeEnrollmentsCount,
      },
      honestMessage: 'Messages already being sent may still go out.',
      notice: 'Resume uses future-only behaviour by default. Missed or expired steps will not burst.',
    };
  }

  /**
   * Resumes a paused campaign.
   * Conforms strictly to Spec p9, p20, B13:
   * - FUTURE_ONLY default policy: skips missed / overdue steps to prevent message bursts.
   * - Logs skipped/expired steps durably.
   * - Rechecks future work and schedules next evaluation.
   * - Triggers calendar planner evaluation.
   */
  async resumeCampaign(params: {
    tenantId: string;
    userId: string;
    campaignId: string;
    policy?: 'FUTURE_ONLY';
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, campaignId, policy = 'FUTURE_ONLY', ip, userAgent } = params;

    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    if (campaign.status === CAMPAIGN_STATUS.ACTIVE) {
      const preview = await this.getResumePreview(tenantId, campaignId);
      return {
        campaign: campaign.toObject(),
        status: CAMPAIGN_STATUS.ACTIVE,
        policy,
        affectedCounts: {
          missedStepsCount: 0,
          futureScheduledCount: preview.affectedCounts.futureCount,
          inProgressCount: preview.affectedCounts.inProgressCount,
        },
        honestMessage: 'Messages already being sent may still go out.',
        message: 'Campaign is already active.',
      };
    }

    if (campaign.status !== CAMPAIGN_STATUS.PAUSED) {
      throw new ValidationError(`Only PAUSED campaigns can be resumed. Current status is '${campaign.status}'.`);
    }

    const effectiveNow = clock.now();

    // 1. FUTURE_ONLY: Find and skip all overdue steps that elapsed while campaign was paused (Spec p9, p20, B13)
    const overdueExecutions = await CampaignExecutionModel.find({
      tenantId,
      campaignId,
      state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
      $or: [
        { dueAt: { $lte: effectiveNow } },
        { expiresAt: { $lte: effectiveNow } },
      ],
    });

    let missedStepsCount = 0;
    if (overdueExecutions.length > 0) {
      const overdueIds = overdueExecutions.map((e) => e.executionId);
      const updateResult = await CampaignExecutionModel.updateMany(
        {
          tenantId,
          executionId: { $in: overdueIds },
          state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
        },
        {
          $set: {
            state: EXECUTION_STATE.SKIPPED,
            skipReason: 'Elapsed step prior to evaluation instant',
          },
        }
      );
      missedStepsCount = updateResult.modifiedCount;

      logger.info(
        { tenantId, campaignId, missedStepsCount, overdueIds },
        'B13: FUTURE_ONLY resume policy: Missed/expired steps skipped with zero message burst.'
      );
    }

    // 2. Transition campaign to ACTIVE and compute next evaluation instant
    campaign.status = CAMPAIGN_STATUS.ACTIVE;

    const earliestFutureExecution: any = await CampaignExecutionModel.findOne({
      tenantId,
      campaignId,
      state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
      dueAt: { $gt: effectiveNow },
    }).sort({ dueAt: 1 }).lean();

    const nextEvaluationAt = await computeNextEvaluationAt(
      tenantId,
      effectiveNow,
      earliestFutureExecution?.dueAt
    );
    campaign.nextEvaluationAt = nextEvaluationAt;
    await campaign.save();

    // 3. Update Control Gate version
    await CampaignControlGateModel.findOneAndUpdate(
      { tenantId, campaignId },
      { $inc: { version: 1 } },
      { upsert: true }
    );

    // 4. Counts for response
    const [futureScheduledCount, inProgressCount] = await Promise.all([
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
      }),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.EVALUATING, EXECUTION_STATE.DISPATCHING] },
      }),
    ]);

    // 5. Trigger Calendar Planner Run (Spec p17)
    try {
      await plannerService.planCampaign(tenantId, campaignId);
    } catch (planErr) {
      logger.error({ planErr, campaignId, tenantId }, 'Resume campaign planning encountered an error');
    }

    await auditService.logEvent({
      tenantId,
      userId,
      action: 'CAMPAIGN_RESUMED',
      metadata: {
        campaignId,
        missedStepsCount,
        futureScheduledCount,
        inProgressCount,
        policy,
        nextEvaluationAt: nextEvaluationAt.toISOString(),
      },
      ip,
      userAgent,
    });

    return {
      campaign: campaign.toObject(),
      status: CAMPAIGN_STATUS.ACTIVE,
      policy,
      affectedCounts: {
        missedStepsCount,
        futureScheduledCount,
        inProgressCount,
      },
      honestMessage: 'Messages already being sent may still go out.',
      message: `Campaign resumed with FUTURE_ONLY policy. ${missedStepsCount} overdue steps were skipped to prevent message bursts. ${futureScheduledCount} future steps remain scheduled.`,
    };
  }

  /**
   * Generates preview of affected execution and enrollment counts before archiving a campaign.
   */
  async getArchivePreview(tenantId: string, campaignId: string) {
    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const [
      unsubmittedCancelledCount,
      inProgressCount,
      acceptedOrDeliveredCount,
      unknownCount,
      failedOrSkippedCount,
      activeEnrollmentsCount,
    ] = await Promise.all([
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
      }),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: EXECUTION_STATE.DISPATCHING,
      }),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.PROVIDER_ACCEPTED, EXECUTION_STATE.SENT, 'DELIVERED', 'READ'] },
      }),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: EXECUTION_STATE.OUTCOME_UNKNOWN,
      }),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: { $in: [EXECUTION_STATE.FAILED, EXECUTION_STATE.EXPIRED, EXECUTION_STATE.SKIPPED] },
      }),
      CampaignEnrollmentModel.countDocuments({
        tenantId,
        campaignId,
        status: 'ACTIVE',
      }),
    ]);

    return {
      campaignId,
      currentStatus: campaign.status,
      affectedCounts: {
        unsubmittedCancelledCount,
        inProgressCount,
        acceptedOrDeliveredCount,
        unknownCount,
        failedOrSkippedCount,
        activeEnrollmentsCount,
      },
      honestMessage:
        'Accepted and outcome-unknown executions are untouched and cannot be recalled. Unsubmitted work will be cancelled and history preserved.',
    };
  }

  /**
   * Archives a campaign.
   * Conforms strictly to Spec p9, p20:
   * - Stops new enrollments.
   * - Cancels remaining unsubmitted work (SCHEDULED, DEFERRED, EVALUATING).
   * - Preserves history: accepted/unknown executions are untouched and cannot be recalled.
   * - Active enrollments marked CANCELLED.
   */
  async archiveCampaign(params: {
    tenantId: string;
    userId: string;
    campaignId: string;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, campaignId, ip, userAgent } = params;

    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    if (campaign.status === CAMPAIGN_STATUS.ARCHIVED) {
      const preview = await this.getArchivePreview(tenantId, campaignId);
      return {
        campaign: campaign.toObject(),
        status: CAMPAIGN_STATUS.ARCHIVED,
        affectedCounts: {
          cancelledExecutionsCount: 0,
          inProgressCount: preview.affectedCounts.inProgressCount,
          preservedHistoryCount:
            preview.affectedCounts.acceptedOrDeliveredCount +
            preview.affectedCounts.unknownCount +
            preview.affectedCounts.failedOrSkippedCount,
        },
        honestMessage:
          'Accepted and outcome-unknown executions are untouched and cannot be recalled. History is preserved.',
        message: 'Campaign is already archived.',
      };
    }

    const session = await mongoose.startSession();
    let cancelledExecutionsCount = 0;

    try {
      session.startTransaction();

      // Cancel unsubmitted executions (SCHEDULED, DEFERRED, EVALUATING)
      const cancelExecResult = await CampaignExecutionModel.updateMany(
        {
          tenantId,
          campaignId,
          state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
        },
        {
          $set: {
            state: EXECUTION_STATE.CANCELLED,
            skipReason: 'Campaign archived',
          },
        },
        { session }
      );
      cancelledExecutionsCount = cancelExecResult.modifiedCount;

      // Cancel active enrollments
      await CampaignEnrollmentModel.updateMany(
        { tenantId, campaignId, status: 'ACTIVE' },
        { $set: { status: 'CANCELLED' } },
        { session }
      );

      // Set campaign status ARCHIVED
      campaign.status = CAMPAIGN_STATUS.ARCHIVED;
      await campaign.save({ session });

      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction();
      throw txErr;
    } finally {
      await session.endSession();
    }

    const [inProgressCount, preservedHistoryCount] = await Promise.all([
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: EXECUTION_STATE.DISPATCHING,
      }),
      CampaignExecutionModel.countDocuments({
        tenantId,
        campaignId,
        state: {
          $in: [
            EXECUTION_STATE.PROVIDER_ACCEPTED,
            EXECUTION_STATE.SENT,
            'DELIVERED',
            'READ',
            EXECUTION_STATE.OUTCOME_UNKNOWN,
            EXECUTION_STATE.FAILED,
            EXECUTION_STATE.EXPIRED,
            EXECUTION_STATE.SKIPPED,
          ],
        },
      }),
    ]);

    await auditService.logEvent({
      tenantId,
      userId,
      action: 'CAMPAIGN_ARCHIVED',
      metadata: {
        campaignId,
        cancelledExecutionsCount,
        inProgressCount,
        preservedHistoryCount,
      },
      ip,
      userAgent,
    });

    return {
      campaign: campaign.toObject(),
      status: CAMPAIGN_STATUS.ARCHIVED,
      affectedCounts: {
        cancelledExecutionsCount,
        inProgressCount,
        preservedHistoryCount,
      },
      honestMessage:
        'Accepted and outcome-unknown executions are untouched and cannot be recalled. Unsubmitted work cancelled and history preserved.',
      message: `Campaign archived successfully. ${cancelledExecutionsCount} unsubmitted steps cancelled. History preserved.`,
    };
  }
}

export const campaignService = new CampaignService();

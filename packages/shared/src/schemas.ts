import { z } from 'zod';
import { ALLOWED_AUDIENCE_FIELDS, ALLOWED_AUDIENCE_OPERATORS } from './constants';

export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  timestamp: z.string(),
  uptimeSeconds: z.number(),
  service: z.string(),
  version: z.string(),
  requestId: z.string().optional(),
  clock: z.object({
    now: z.string(),
    offsetMs: z.number(),
    isDevOffsetActive: z.boolean(),
  }),
});

export const DbHealthStatusSchema = z.object({
  status: z.enum(['connected', 'disconnected', 'error']),
  database: z.string(),
  isReplicaSet: z.boolean(),
  replicaSetName: z.string().optional(),
  isPrimary: z.boolean().optional(),
  transactionsSupported: z.boolean(),
  hosts: z.array(z.string()).optional(),
  error: z.string().optional(),
  timestamp: z.string(),
  requestId: z.string().optional(),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional(),
    requestId: z.string().optional(),
  }),
});

export const ClockOffsetBodySchema = z.object({
  offsetMs: z.number().int({ message: 'offsetMs must be an integer' }),
});

export const UserRoleSchema = z.enum(['owner', 'admin', 'staff']);

export const LoginBodySchema = z.object({
  email: z.string().trim().email({ message: 'Valid email is required' }),
  password: z.string().min(1, { message: 'Password is required' }),
});

export const ChangeUserRoleSchema = z.object({
  role: UserRoleSchema,
});

export const TemplateVariableSchema = z.object({
  index: z.number().int().positive(),
  name: z.string(),
  type: z.string(),
  sample: z.string(),
});

export const TemplateCategorySchema = z.enum(['MARKETING', 'UTILITY', 'UNKNOWN']);
export const TemplateSourceSchema = z.enum(['META_PROVIDED', 'DUMMY']);

export const SourceTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.string().min(1),
  category: TemplateCategorySchema,
  status: z.string().min(1),
  bodyText: z.string().nullable(),
  variables: z.array(TemplateVariableSchema),
  revision: z.number().int().positive(),
  sendable: z.boolean(),
  source: TemplateSourceSchema,
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export const SourceConnectionSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  wabaId: z.string().min(1),
  secretRef: z.string().min(1),
  graphApiVersion: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export const FixOwnerSchema = z.enum(['INTEGRATION_DEVELOPER', 'BOUTIQUE_OWNER', 'SYSTEM_ADMIN', 'PRODUCT_MANAGER']);

export const ReadinessFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  fixOwner: FixOwnerSchema,
});

export const IntegrationReadinessReportSchema = z.object({
  ready: z.boolean(),
  tenantId: z.string(),
  connection: z
    .object({
      id: z.string(),
      phoneNumberId: z.string(),
      wabaId: z.string(),
      secretRef: z.string(),
      graphApiVersion: z.string(),
      status: z.string(),
    })
    .nullable(),
  checks: z.object({
    connectionExists: z.object({ passed: z.boolean(), message: z.string().optional() }),
    tokenPresent: z.object({ passed: z.boolean(), message: z.string().optional() }),
    allowlistConfigured: z.object({ passed: z.boolean(), message: z.string().optional() }),
    hasSendableTemplate: z.object({ passed: z.boolean(), message: z.string().optional() }),
  }),
  sendableTemplatesCount: z.number().int().nonnegative(),
  totalTemplatesCount: z.number().int().nonnegative(),
  failures: z.array(ReadinessFailureSchema),
  notice: z.string(),
  timestamp: z.string(),
});

export const TemplateCatalogueResponseSchema = z.object({
  templates: z.array(SourceTemplateSchema),
  total: z.number().int().nonnegative(),
  sendableCount: z.number().int().nonnegative(),
  metaProvidedCount: z.number().int().nonnegative(),
  dummyCount: z.number().int().nonnegative(),
});

// ============================================================================
// Campaign Settings Schemas (Feature 4 - Spec p7, p17, p18, p26)
// ============================================================================

import { isValidISODate, isValidIANATimezone, isValidBookingLinkUrl } from './utils';

export const SendingHoursSchema = z
  .object({
    start: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'Start time must be in HH:mm 24-hour format (e.g. 10:00)',
      }),
    end: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'End time must be in HH:mm 24-hour format (e.g. 19:00)',
      }),
  })
  .superRefine((data, ctx) => {
    const [startH, startM] = data.start.split(':').map(Number);
    const [endH, endM] = data.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes === endMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'Start time and end time cannot be equal (spec p7 requires a non-zero sending window)',
      });
    } else if (startMinutes > endMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'Overnight sending hours (start time after end time) are rejected in v1 (spec p7)',
      });
    }
  });

export const HolidayItemSchema = z.object({
  date: z.string().refine(isValidISODate, {
    message: 'Date must be a valid calendar date in YYYY-MM-DD format',
  }),
  name: z.string().trim().min(1, { message: 'Holiday name is required' }).max(100),
});

export const BlackoutDateSchema = z.string().refine(isValidISODate, {
  message: 'Blackout date must be a valid calendar date in YYYY-MM-DD format',
});

export const MarketingCapsSchema = z
  .object({
    daily: z
      .number()
      .int({ message: 'Daily marketing cap must be an integer' })
      .min(0, { message: 'Daily marketing cap cannot be negative' })
      .max(1, {
        message: 'Daily marketing cap cannot exceed tenant maximum of 1 per 24 hours (spec p7, p18)',
      }),
    weekly: z
      .number()
      .int({ message: 'Weekly marketing cap must be an integer' })
      .min(0, { message: 'Weekly marketing cap cannot be negative' })
      .max(3, {
        message: 'Weekly marketing cap cannot exceed tenant maximum of 3 per 7 days (spec p7, p18)',
      }),
  })
  .superRefine((data, ctx) => {
    if (data.daily > 0 && data.weekly < data.daily) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekly'],
        message: 'Weekly marketing cap cannot be less than daily marketing cap',
      });
    }
  });

export const UpdateMarketingCapsSchema = z
  .object({
    daily: z
      .number()
      .int({ message: 'Daily marketing cap must be an integer' })
      .min(0, { message: 'Daily marketing cap cannot be negative' })
      .max(1, {
        message: 'Daily marketing cap cannot exceed tenant maximum of 1 per 24 hours (spec p7, p18)',
      })
      .optional(),
    weekly: z
      .number()
      .int({ message: 'Weekly marketing cap must be an integer' })
      .min(0, { message: 'Weekly marketing cap cannot be negative' })
      .max(3, {
        message: 'Weekly marketing cap cannot exceed tenant maximum of 3 per 7 days (spec p7, p18)',
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.daily !== undefined && data.weekly !== undefined && data.daily > 0 && data.weekly < data.daily) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekly'],
        message: 'Weekly marketing cap cannot be less than daily marketing cap',
      });
    }
  });

export const PriorityAllowlistRangesSchema = z
  .object({
    birthday: z.number().int().min(1).max(100),
    anniversary: z.number().int().min(1).max(100),
    wedding: z.number().int().min(1).max(100),
    requestedStock: z.number().int().min(1).max(100),
    festival: z.number().int().min(1).max(100),
    winBack: z.number().int().min(1).max(100),
  })
  .catchall(z.number().int().min(1).max(100));

export const UpdatePriorityAllowlistRangesSchema = z
  .object({
    birthday: z.number().int().min(1).max(100).optional(),
    anniversary: z.number().int().min(1).max(100).optional(),
    wedding: z.number().int().min(1).max(100).optional(),
    requestedStock: z.number().int().min(1).max(100).optional(),
    festival: z.number().int().min(1).max(100).optional(),
    winBack: z.number().int().min(1).max(100).optional(),
  })
  .catchall(z.number().int().min(1).max(100));

export const UpdateCampaignSettingsSchema = z.object({
  expectedVersion: z
    .number()
    .int({ message: 'expectedVersion must be an integer' })
    .min(1, { message: 'expectedVersion must be at least 1' }),
  idempotencyKey: z.string().optional(),
  timezone: z
    .string()
    .refine(isValidIANATimezone, {
      message: 'Timezone must be a valid IANA timezone identifier (e.g. Asia/Kolkata)',
    })
    .optional(),
  allowedSendingHours: SendingHoursSchema.optional(),
  blackoutDates: z.array(BlackoutDateSchema).optional(),
  holidays: z.array(HolidayItemSchema).optional(),
  marketingCaps: UpdateMarketingCapsSchema.optional(),
  serviceContactSpacingHours: z
    .number()
    .int({ message: 'serviceContactSpacingHours must be an integer' })
    .min(1, { message: 'Service contact spacing must be at least 1 hour' })
    .max(720, { message: 'Service contact spacing cannot exceed 720 hours (30 days)' })
    .optional(),
  outageGraceHours: z
    .number()
    .int({ message: 'outageGraceHours must be an integer' })
    .min(1, { message: 'Outage grace must be at least 1 hour' })
    .max(72, { message: 'Outage grace cannot exceed 72 hours' })
    .optional(),
  resumePolicy: z
    .literal('FUTURE_ONLY', {
      errorMap: () => ({
        message: "Only 'FUTURE_ONLY' resume policy is permitted (spec p7/p17 forbids silent bulk catch-up)",
      }),
    })
    .optional(),
  importPolicy: z
    .literal('FUTURE_ONLY', {
      errorMap: () => ({
        message: "Only 'FUTURE_ONLY' import policy is permitted (spec p7 forbids historical backlog)",
      }),
    })
    .optional(),
  priorityAllowlistRanges: UpdatePriorityAllowlistRangesSchema.optional(),
  defaultPhoneCountry: z.string().min(2).max(4).optional(),
  minDestinationVerification: z.enum(['UNVERIFIED', 'FORMAT_VALID', 'CONFIRMED_BY_STAFF', 'OTP_VERIFIED']).optional(),
  bookingLinkUrl: z
    .string()
    .trim()
    .max(200, { message: 'bookingLinkUrl cannot exceed 200 characters' })
    .refine((val) => val === '' || isValidBookingLinkUrl(val), {
      message: 'bookingLinkUrl must be a valid https URL with a public domain (no IP literals, no localhost, no credentials)',
    })
    .nullable()
    .optional(),
  isPaused: z.boolean().optional(),
});

export const CampaignSettingsResponseSchema = z.object({
  id: z.string().optional(),
  _id: z.string().optional(),
  tenantId: z.string(),
  version: z.number().int().positive(),
  timezone: z.string(),
  allowedSendingHours: SendingHoursSchema,
  blackoutDates: z.array(z.string()),
  holidays: z.array(HolidayItemSchema),
  marketingCaps: MarketingCapsSchema,
  serviceContactSpacingHours: z.number().int().positive(),
  outageGraceHours: z.number().int().positive(),
  resumePolicy: z.literal('FUTURE_ONLY'),
  importPolicy: z.literal('FUTURE_ONLY'),
  priorityAllowlistRanges: PriorityAllowlistRangesSchema,
  defaultPhoneCountry: z.string().default('IN').optional(),
  minDestinationVerification: z.enum(['UNVERIFIED', 'FORMAT_VALID', 'CONFIRMED_BY_STAFF', 'OTP_VERIFIED']).default('CONFIRMED_BY_STAFF').optional(),
  bookingLinkUrl: z.string().nullable().optional(),
  isPaused: z.boolean(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

// ============================================================================
// Campaign Management Schemas (Feature 5 - Spec p5-8, p20-26)
// ============================================================================

export const CampaignStatusSchema = z.enum([
  'DRAFT',
  'VALIDATED',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
]);

export const LeapDayPolicySchema = z.enum(['FEB_28', 'MAR_01', 'LEAP_ONLY']);

export const PrerequisiteSchema = z.enum(['NONE', 'PREVIOUS_ACCEPTED']);

export const TemplateRefSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  language: z.string().min(1),
});

export const DelaySpecSchema = z
  .object({
    unit: z.enum(['MINUTES', 'HOURS', 'DAYS']),
    value: z.number().int().min(0, 'Delay cannot be negative'),
  })
  .superRefine((val, ctx) => {
    if (val.unit === 'MINUTES' && val.value > 1440) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Delay in minutes cannot exceed 1440 minutes (24 hours)',
        path: ['value'],
      });
    }
    if (val.unit === 'HOURS' && val.value > 168) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Delay in hours cannot exceed 168 hours (7 days)',
        path: ['value'],
      });
    }
    if (val.unit === 'DAYS' && val.value > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Delay in days cannot exceed 30 days',
        path: ['value'],
      });
    }
  });

export const OfferRefSchema = z.object({
  offerId: z.string().min(1, 'offerId is required'),
  version: z.number().int().nonnegative().optional(),
});

export const CreditRefSchema = z.object({
  selector: z.enum(['BY_SOURCE_ORDER', 'BY_CREDIT_ID']).default('BY_SOURCE_ORDER'),
  reason: z.string().optional(),
  creditId: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
});

export const EventDelayStepSchema = z.object({
  stepId: z.string().trim().min(1),
  stepName: z.string().nullish(),
  kind: z.literal('EVENT_DELAY').optional(),
  delay: DelaySpecSchema,
  outsideHoursPolicy: z.enum(['DEFER_NEXT_DAY', 'SKIP']).default('DEFER_NEXT_DAY'),
  maxDeferralHours: z.number().int().min(0).max(48).default(24),
  maxLatenessMinutes: z.number().int().positive().default(180),
  offerRef: OfferRefSchema.nullish(),
  creditRef: CreditRefSchema.nullish(),
  prerequisite: PrerequisiteSchema.default('NONE'),
  templateRef: TemplateRefSchema.nullable(),
  bindings: z.record(z.any()).optional().default({}),
  stopOnReply: z.boolean().default(false),
  stopOnGoal: z.boolean().default(false),
  relativeToAnchorHours: z.number().nullish(),
});

export const AnnualDateStepSchema = z.object({
  stepId: z.string().trim().min(1),
  stepName: z.string().nullish(),
  kind: z.literal('ANNUAL_DATE').optional(),
  offsetDays: z.number().int(),
  localTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'localTime must be in HH:mm 24-hour format (e.g. 10:00)',
  }),
  prerequisite: PrerequisiteSchema.default('NONE'),
  templateRef: TemplateRefSchema.nullable(),
  bindings: z.record(z.any()).optional().default({}),
  stopOnReply: z.boolean().default(false),
  stopOnGoal: z.boolean().default(false),
  maxLatenessMinutes: z.number().int().positive().default(120),
});

export const DateOffsetStepSchema = z.object({
  stepId: z.string().trim().min(1),
  stepName: z.string().nullish(),
  kind: z.literal('DATE_OFFSET').optional(),
  offsetDays: z.number().int(),
  localTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'localTime must be in HH:mm 24-hour format (e.g. 10:00)',
  }).default('10:00'),
  outsideHoursPolicy: z.enum(['DEFER_NEXT_DAY', 'SKIP']).default('DEFER_NEXT_DAY'),
  maxDeferralHours: z.number().int().min(0).max(48).default(24),
  maxLatenessMinutes: z.number().int().positive().default(720),
  offerRef: OfferRefSchema.nullish(),
  creditRef: CreditRefSchema.nullish(),
  prerequisite: PrerequisiteSchema.default('NONE'),
  templateRef: TemplateRefSchema.nullable(),
  bindings: z.record(z.any()).optional().default({}),
  stopOnReply: z.boolean().default(true),
  stopOnGoal: z.boolean().default(false),
  relativeToAnchorHours: z.number().nullish(),
});

export const PostExpiryStepSchema = z.object({
  stepId: z.string().trim().min(1),
  stepName: z.string().nullish(),
  kind: z.literal('POST_EXPIRY').optional(),
  delay: DelaySpecSchema.optional(),
  delayHours: z.number().min(0).max(72).default(2),
  acknowledgeSpecDeviation: z.boolean().default(false),
  outsideHoursPolicy: z.enum(['DEFER_NEXT_DAY', 'SKIP']).default('DEFER_NEXT_DAY'),
  maxDeferralHours: z.number().int().min(0).max(48).default(24),
  maxLatenessMinutes: z.number().int().positive().default(720),
  prerequisite: PrerequisiteSchema.default('NONE'),
  templateRef: TemplateRefSchema.nullable(),
  bindings: z.record(z.any()).optional().default({}),
  stopOnReply: z.boolean().default(true),
  stopOnGoal: z.boolean().default(false),
  relativeToAnchorHours: z.number().nullish(),
});

export const CampaignStepSchema = z.union([
  EventDelayStepSchema,
  DateOffsetStepSchema,
  PostExpiryStepSchema,
  AnnualDateStepSchema,
]);

export const CampaignTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ANNUAL_DATE'),
    field: z.string().min(1),
    leapDayPolicy: LeapDayPolicySchema,
    thresholdDays: z.number().nullish(),
    category: z.string().nullish(),
    ruleId: z.string().nullish(),
    anchor: z.string().nullish(),
  }),
  z.object({
    type: z.literal('INACTIVITY_THRESHOLD'),
    field: z.string().nullish(),
    leapDayPolicy: LeapDayPolicySchema.nullish(),
    thresholdDays: z.number().int().positive().optional().default(90),
    category: z.string().nullish(),
    ruleId: z.string().nullish().default('default'),
    anchor: z.string().nullish(),
  }),
  z.object({
    type: z.literal('EVENT_DELAY'),
    anchor: z.enum([
      'FIRST_QUALIFYING_ORDER',
      'CREDIT_ISSUED',
      'CREDIT_EXPIRED_AT',
      'ENQUIRY_LAST_INTERACTION',
    ]).default('FIRST_QUALIFYING_ORDER'),
    field: z.string().nullish(),
    leapDayPolicy: LeapDayPolicySchema.nullish(),
    thresholdDays: z.number().nullish(),
    category: z.string().nullish(),
    ruleId: z.string().nullish(),
  }),
  z.object({
    type: z.literal('ENQUIRY_EVENT_DELAY'),
    anchor: z.enum(['ENQUIRY_LAST_INTERACTION']).default('ENQUIRY_LAST_INTERACTION'),
    field: z.string().nullish(),
    leapDayPolicy: LeapDayPolicySchema.nullish(),
    thresholdDays: z.number().nullish(),
    category: z.string().nullish(),
    ruleId: z.string().nullish(),
  }),
  z.object({
    type: z.literal('ORDER_EVENT_DELAY'),
    anchor: z.enum(['ORDER_COMPLETED_AT']).default('ORDER_COMPLETED_AT'),
    field: z.string().nullish(),
    leapDayPolicy: LeapDayPolicySchema.nullish(),
    thresholdDays: z.number().nullish(),
    category: z.string().nullish(),
    ruleId: z.string().nullish(),
  }),
  z.object({
    type: z.literal('REQUEST_STOCK_AVAILABLE'),
    anchor: z.enum(['STOCK_PUBLISHED_AT']).default('STOCK_PUBLISHED_AT'),
    field: z.string().nullish(),
    leapDayPolicy: LeapDayPolicySchema.nullish(),
    thresholdDays: z.number().nullish(),
    category: z.string().nullish(),
    ruleId: z.string().nullish(),
  }),
  z.object({
    type: z.literal('CREDIT_EXPIRY'),
    anchor: z.string().nullish().default('CREDIT_EXPIRY'),
    field: z.string().nullish(),
    leapDayPolicy: LeapDayPolicySchema.nullish(),
    thresholdDays: z.number().nullish(),
    category: z.string().nullish(),
    ruleId: z.string().nullish(),
    reasonFilter: z.array(z.string()).optional(),
    unitFilter: z.enum(['POINTS', 'PAISE']).optional(),
    amountGte: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('CUSTOMER_EVENT_DATE'),
    occasionKind: z.enum(['GIFT', 'WEDDING']),
    fulfillmentLeadDays: z.number().int().min(0).max(180).default(21),
    field: z.string().nullish(),
    leapDayPolicy: LeapDayPolicySchema.nullish(),
    thresholdDays: z.number().nullish(),
    category: z.string().nullish(),
    ruleId: z.string().nullish(),
    anchor: z.string().nullish(),
  }),
]);

export const AudienceRulePredicateSchema = z.object({
  field: z.enum(ALLOWED_AUDIENCE_FIELDS, {
    errorMap: () => ({ message: 'Unsupported field in audience predicate' }),
  }),
  op: z.enum(ALLOWED_AUDIENCE_OPERATORS, {
    errorMap: () => ({ message: 'Unsupported operator in audience predicate' }),
  }),
  value: z.any(),
});

export const AudienceRulesSchema = z.object({
  all: z.array(AudienceRulePredicateSchema).optional().default([]),
  any: z.array(AudienceRulePredicateSchema).optional().default([]),
  none: z.array(AudienceRulePredicateSchema).optional().default([]),
});

export const CampaignAudienceSchema = z.union([
  z.object({
    mode: z.literal('ALL_ELIGIBLE'),
    rules: AudienceRulesSchema.nullish(),
  }),
  z.object({
    mode: z.literal('CUSTOM_RULES'),
    rules: AudienceRulesSchema.nullish(),
  }),
]);

export const CreateCampaignInputSchema = z
  .object({
    presetId: z.string().min(1),
    name: z.string().trim().min(3).max(100),
    enabledBranches: z.array(z.string()).min(1).optional(),
    startAt: z.union([z.string(), z.date()]).nullish(),
    endAt: z.union([z.string(), z.date()]).nullish(),
    scope: z.enum(['PER_CUSTOMER', 'PER_CUSTOMER_PER_BRANCH']).optional(),
    schemaVersion: z.number().int().positive().optional(),
    minFirstOrderNetPaise: z.number().int().min(0).max(100000000).optional(),
  })
  .strict();

export const UpdateCampaignDraftInputSchema = z
  .object({
    expectedVersion: z.number().int().positive({
      message: 'expectedVersion must be a positive integer for optimistic concurrency',
    }),
    name: z.string().trim().min(3).max(100).optional(),
    enabledBranches: z.array(z.string()).min(1).optional(),
    timezone: z
      .string()
      .refine(isValidIANATimezone, { message: 'Must be a valid IANA timezone (e.g. Asia/Kolkata)' })
      .optional(),
    trigger: CampaignTriggerSchema.optional(),
    audience: CampaignAudienceSchema.optional(),
    goal: z
      .object({
        type: z.string().min(1),
      })
      .optional(),
    steps: z.array(CampaignStepSchema).min(1).max(3).optional(),
    priority: z.number().int().min(1).max(100).optional(),
    resumePolicy: z.literal('FUTURE_ONLY').optional(),
    importPolicy: z.literal('FUTURE_ONLY').optional(),
    startAt: z.union([z.string(), z.date()]).nullish(),
    endAt: z.union([z.string(), z.date()]).nullish(),
    scope: z.enum(['PER_CUSTOMER', 'PER_CUSTOMER_PER_BRANCH']).optional(),
    schemaVersion: z.number().int().positive().optional(),
    minFirstOrderNetPaise: z.number().int().min(0).max(100000000).optional(),
  })
  .strict();

export const PublishRevisionInputSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
});

export const CampaignValidationItemSchema = z.object({
  fieldPath: z.string(),
  message: z.string(),
  code: z.string().optional(),
  resolutionOwner: FixOwnerSchema,
});

export const CampaignValidationReportSchema = z.object({
  valid: z.boolean(),
  errors: z.array(CampaignValidationItemSchema),
  warnings: z.array(CampaignValidationItemSchema),
});

export const CampaignPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  triggerFamily: z.string(),
  implemented: z.boolean(),
  category: z.string(),
  defaults: z.record(z.any()).optional(),
});

export const DryRunStepPlanSchema = z.object({
  stepId: z.string(),
  stepName: z.string(),
  offsetDays: z.number().int(),
  localDate: z.string(),
  localTime: z.string(),
  timezone: z.string(),
  dueAtUtc: z.union([z.string(), z.date()]),
  expiresAtUtc: z.union([z.string(), z.date()]),
  status: z.enum(['SCHEDULED', 'SKIPPED_ELAPSED', 'SKIPPED_EXPIRY']),
  skipReason: z.string().optional(),
  renderedMessage: z.string(),
  templateId: z.string(),
  templateName: z.string(),
});

export const SampleRecipientPlanSchema = z.object({
  customerId: z.string(),
  customerName: z.string(),
  maskedPhone: z.string(),
  occurrenceId: z.string(),
  occasionLocalDate: z.string(),
  matchExplanation: z.string(),
  firstLocalDate: z.string(),
  firstDueAtUtc: z.union([z.string(), z.date()]),
  steps: z.array(DryRunStepPlanSchema),
});

export const ExcludedSampleSchema = z.object({
  customerId: z.string(),
  customerName: z.string(),
  primaryReason: z.string(),
  details: z.string().optional(),
});

export const CampaignDryRunSchema = z.object({
  id: z.string().optional(),
  _id: z.string().optional(),
  dryRunId: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  draftVersion: z.number().int().positive(),
  draftFingerprint: z.string(),
  counts: z.object({
    scanned: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
  reasonBreakdown: z.record(z.number().int().nonnegative()),
  samplePlans: z.array(SampleRecipientPlanSchema),
  excludedSamples: z.array(ExcludedSampleSchema),
  evaluatedAt: z.union([z.string(), z.date()]),
  evaluatedBy: z.string().optional(),
  isStale: z.boolean().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export const ResolveHoldInputSchema = z
  .object({
    cause: z.string().max(500).optional(),
    reason: z.string().max(500).optional(),
    supportingRecord: z.string().max(500).optional(),
    note: z.string().max(500).optional(),
  })
  .refine(
    (data) =>
      (typeof data.cause === 'string' && data.cause.trim().length > 0) ||
      (typeof data.reason === 'string' && data.reason.trim().length > 0) ||
      (typeof data.note === 'string' && data.note.trim().length > 0),
    {
      message: 'Cause is required to resolve hold',
      path: ['cause'],
    }
  );

export type ResolveHoldInput = z.infer<typeof ResolveHoldInputSchema>;

export const MarkGoalInputSchema = z.object({
  cause: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
  orderRef: z.string().max(200).optional(),
  supportingRecord: z.string().max(500).optional(),
  at: z.union([z.string(), z.date()]).optional(),
});

export type MarkGoalInput = z.infer<typeof MarkGoalInputSchema>;

export const CampaignEventInputSchema = z
  .preprocess(
    (raw: any) => {
      if (raw && typeof raw === 'object') {
        const data = raw.data || raw.payload || {};
        const producer =
          raw.producer ||
          (raw.source ? String(raw.source).replace(/^\//, '') : undefined);
        const eventId = raw.eventId || raw.id;
        const type = raw.type || raw.eventType;
        const entityId =
          raw.entityId ||
          data.enquiryId ||
          data.orderId ||
          data.customerId ||
          data.entityId;
        const entityVersion =
          raw.entityVersion !== undefined
            ? raw.entityVersion
            : data.entityVersion !== undefined
            ? data.entityVersion
            : 1;
        const occurredAt =
          raw.occurredAt ||
          raw.time ||
          data.createdAt ||
          data.updatedAt ||
          new Date().toISOString();
        const tenantId = raw.tenantId || data.tenantId;
        const customerId =
          raw.customerId !== undefined
            ? raw.customerId
            : data.customerId !== undefined
            ? data.customerId
            : null;

        return {
          ...raw,
          schemaVersion: raw.schemaVersion || 1,
          producer,
          eventId,
          type,
          entityId,
          entityVersion,
          occurredAt,
          tenantId,
          customerId,
          data,
        };
      }
      return raw;
    },
    z.object({
      schemaVersion: z.number().int().positive().default(1),
      producer: z.string().min(1, 'Producer is required'),
      eventId: z.string().min(1, 'Event ID is required'),
      tenantId: z.string().optional(),
      type: z.string().optional(),
      eventType: z.string().optional(),
      entityId: z.string().min(1, 'Entity ID is required'),
      entityVersion: z.number().int().nonnegative(),
      occurredAt: z.union([z.string(), z.date()]),
      receivedAt: z.union([z.string(), z.date()]).optional(),
      customerId: z.string().nullable().optional(),
      data: z.record(z.any()).optional(),
      payload: z.record(z.any()).optional(),
    })
  )
  .transform((val) => {
    const finalType = val.type || val.eventType || '';
    const finalData = val.data || val.payload || {};
    return {
      schemaVersion: val.schemaVersion,
      producer: val.producer,
      eventId: val.eventId,
      tenantId: val.tenantId,
      type: finalType,
      entityId: val.entityId,
      entityVersion: val.entityVersion,
      occurredAt: val.occurredAt,
      receivedAt: val.receivedAt,
      customerId: val.customerId !== undefined ? val.customerId : ((finalData as any)?.customerId ?? null),
      data: finalData,
    };
  })
  .refine((val) => Boolean(val.type && val.type.length > 0), {
    message: 'Event type is required (either type or eventType)',
    path: ['type'],
  });

export type CampaignEventInput = z.infer<typeof CampaignEventInputSchema>;

export const DelayReasonItemSchema = z.object({
  reason: z.string(),
  count: z.number().int().nonnegative(),
});

export const PrimaryReasonItemSchema = z.object({
  reason: z.string(),
  count: z.number().int().nonnegative(),
  category: z.enum(['SKIPPED', 'CANCELLED', 'EXPIRED']),
});

export const StepFunnelItemSchema = z.object({
  stepId: z.string(),
  stepName: z.string(),
  scheduled: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

export const AttributedOrderSchema = z.object({
  orderId: z.string(),
  customerId: z.string(),
  status: z.string(),
  paid: z.boolean(),
  netPaise: z.number().int(),
  netRupees: z.number(),
  occasionRef: z.string().nullable(),
  attributionSource: z.enum(['GOAL_EVENT', 'ENROLLMENT_LINK', 'OCCASION_REF']),
  supportingRecord: z.string().optional().nullable(),
  completedAt: z.string().nullable(),
});

export const CampaignReportSchema = z.object({
  campaignId: z.string(),
  campaignName: z.string(),
  status: z.string(),
  presetId: z.string().optional(),
  statedAt: z.string(),
  eligible: z.object({
    count: z.number().int().nonnegative(),
    statedAt: z.string().nullable(),
  }),
  enrollments: z.object({
    total: z.number().int().nonnegative(),
    uniqueCustomers: z.number().int().nonnegative(),
  }),
  executionCounts: z.object({
    total: z.number().int().nonnegative(),
    scheduled: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    nextScheduledDueAt: z.string().nullable(),
    delayReasons: z.array(DelayReasonItemSchema),
    skipped: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    outcomeUnknown: z.number().int().nonnegative(),
    primaryReasons: z.array(PrimaryReasonItemSchema),
  }),
  deliveryEvidence: z.object({
    accepted: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    notice: z.string(),
  }),
  repliesAndHolds: z.object({
    totalHeldOrReplied: z.number().int().nonnegative(),
    exactCampaignReplies: z.number().int().nonnegative(),
    conservativeHolds: z.number().int().nonnegative(),
    currentlyOnHold: z.number().int().nonnegative(),
    resolvedHolds: z.number().int().nonnegative(),
  }),
  goalCompletions: z.object({
    total: z.number().int().nonnegative(),
    orderOccasion: z.number().int().nonnegative(),
    staffManual: z.number().int().nonnegative(),
    details: z.array(
      z.object({
        goalEventId: z.string(),
        source: z.string(),
        orderRef: z.string().optional().nullable(),
        cause: z.string().optional().nullable(),
        at: z.string(),
      })
    ),
  }),
  attribution: z.object({
    model: z.string(),
    assumptionNotice: z.string().optional(),
    orderCount: z.number().int().nonnegative(),
    totalNetSalesPaise: z.number().int(),
    totalNetSalesRupees: z.number(),
    refundsCount: z.number().int().nonnegative(),
    refundedPaise: z.number().int().nonnegative(),
    orders: z.array(AttributedOrderSchema),
  }),
  unassignedStoreOrders: z.object({
    orderCount: z.number().int().nonnegative(),
    netSalesPaise: z.number().int(),
    netSalesRupees: z.number(),
  }),
  stepFunnel: z.array(StepFunnelItemSchema),
});

export const CustomerTimelineStepSchema = z.object({
  executionId: z.string(),
  stepId: z.string(),
  stepName: z.string(),
  state: z.string(),
  skipReason: z.string().nullable(),
  plannedDueAt: z.string(),
  plannedLocalDate: z.string(),
  plannedLocalTime: z.string(),
  timezone: z.string(),
  actualDispatchedAt: z.string().nullable(),
  actualDeliveredAt: z.string().nullable(),
  actualReadAt: z.string().nullable(),
  template: z
    .object({
      id: z.string(),
      revision: z.number().int(),
      language: z.string(),
    })
    .nullable(),
  statusHistory: z.array(
    z.object({
      state: z.string(),
      timestamp: z.string(),
      details: z.string().optional(),
    })
  ),
  providerMessageId: z.string().nullable(),
  lastErrorCategory: z.string().nullable(),
  attemptsCount: z.number().int().nonnegative(),
});

export const CustomerTimelineReportSchema = z.object({
  customerId: z.string(),
  customerName: z.string(),
  maskedPhone: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  campaignName: z.string(),
  enrollment: z.object({
    enrollmentId: z.string(),
    occurrenceId: z.string(),
    occasionLocalDate: z.string(),
    status: z.string(),
    matchExplanation: z.string(),
    createdAt: z.string(),
    replyHoldAt: z.string().nullable(),
    replyAttribution: z.string().nullable(),
    lastReplyHoldAt: z.string().nullable(),
    holdResolvedAt: z.string().nullable(),
    holdResolutionCause: z.string().nullable(),
    goalReachedAt: z.string().nullable(),
    goalSource: z.string().nullable(),
    goalOrderRef: z.string().nullable(),
  }),
  steps: z.array(CustomerTimelineStepSchema),
  linkedOrders: z.array(AttributedOrderSchema),
});

export const ReconciliationResultSchema = z.object({
  checkpointId: z.string(),
  tenantId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  status: z.enum(['COMPLETED', 'FAILED']),
  counts: z.object({
    stalledLeasesReleased: z.number().int().nonnegative(),
    orphanedIntentsCleaned: z.number().int().nonnegative(),
    expiredStepsMarked: z.number().int().nonnegative(),
    missedEventsProcessed: z.number().int().nonnegative(),
    totalScanned: z.number().int().nonnegative(),
  }),
  details: z.array(z.string()),
});

export const PruneCampaignDataInputSchema = z.object({
  campaignId: z.string().optional(),
  cutoffDays: z.number().int().positive().default(90),
  retentionReason: z.string().max(200).default('DATA_RETENTION_PRUNING'),
});

export type PruneCampaignDataInput = z.infer<typeof PruneCampaignDataInputSchema>;


export const SourceOfferSchema = z.object({
  id: z.string().optional(),
  _id: z.string().optional(),
  offerId: z.string(),
  tenantId: z.string(),
  kind: z.enum(['FLAT_AMOUNT_OFF_NEXT_PURCHASE', 'SELECTED_STOCK']),
  amountPaise: z.number().int().positive().optional(),
  name: z.string().max(60).optional(),
  publishedAt: z.union([z.string(), z.date()]).nullable().optional(),
  discount: z.object({
    type: z.enum(['PERCENT_OFF', 'FLAT_OFF', 'SPECIAL_PRICE']),
    percent: z.number().int().min(1).max(90).optional(),
    flatOffPaise: z.number().int().positive().optional(),
  }).optional(),
  terms: z.string().max(120).optional(),
  tags: z.array(z.string()).optional(),
  branchIds: z.array(z.string()).optional(),
  items: z.array(z.object({
    productId: z.string().min(1),
    variantIds: z.array(z.string()).nullable().optional(),
    offerPricePaise: z.number().int().positive().nullable().optional(),
    position: z.number().int().nonnegative(),
  })).optional(),
  validFrom: z.union([z.string(), z.date()]),
  validUntil: z.union([z.string(), z.date()]),
  status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED']),
  version: z.number().int().positive(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export type SourceOfferDto = z.infer<typeof SourceOfferSchema>;

export const WelcomeSummarySchema = z.object({
  campaignId: z.string(),
  tenantId: z.string(),
  enrollments: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  excludedByReason: z.record(z.number().int().nonnegative()),
  scheduled: z.number().int().nonnegative(),
  deferredCount: z.number().int().nonnegative(),
  deferredByReason: z.record(z.number().int().nonnegative()),
  skippedCount: z.number().int().nonnegative(),
  skippedByReason: z.record(z.number().int().nonnegative()),
  accepted: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  repliesAndHolds: z.object({
    totalHeldOrReplied: z.number().int().nonnegative(),
    exactCampaignReplies: z.number().int().nonnegative(),
    conservativeHolds: z.number().int().nonnegative(),
    currentlyOnHold: z.number().int().nonnegative(),
    resolvedHolds: z.number().int().nonnegative(),
  }),
  note: z.string(),
});

export type WelcomeSummaryDto = z.infer<typeof WelcomeSummarySchema>;


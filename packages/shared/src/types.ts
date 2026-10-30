export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptimeSeconds: number;
  service: string;
  version: string;
  requestId?: string;
  clock: {
    now: string;
    offsetMs: number;
    isDevOffsetActive: boolean;
  };
}

export interface DbHealthStatus {
  status: 'connected' | 'disconnected' | 'error';
  database: string;
  isReplicaSet: boolean;
  replicaSetName?: string;
  isPrimary?: boolean;
  transactionsSupported: boolean;
  hosts?: string[];
  error?: string;
  timestamp: string;
  requestId?: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown> | unknown[];
    requestId?: string;
  };
}

export interface ClockStatus {
  now: string;
  epochMs: number;
  offsetMs: number;
  isDevOffsetActive: boolean;
  isProduction: boolean;
}

import {
  UserRole,
  CampaignStatus,
  LeapDayPolicy,
  Prerequisite,
  AllowedBindingSource,
  AllowedAudienceField,
  AllowedAudienceOperator,
  ExclusionReason,
  EnrollmentStatus,
  ExecutionState,
  CheckpointStatus,
  EventInboxStatus,
  QuarantineReason,
  CampaignScope,
  DestinationVerificationLevel,
  DestinationVerificationMethod,
  ConsentSource,
  ProductCategory,
  ColourFamily,
  NeutralColourFamily,
  Weave,
  ColourMatchMode,
  GoalMode,
} from './constants';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: UserRole;
  branchIds: string[];
  email: string;
}

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  branchIds: string[];
  name?: string;
}

export interface TenantInfo {
  tenantId: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt?: string;
  updatedAt?: string;
}

export interface BranchInfo {
  tenantId: string;
  branchId: string;
  name: string;
  isMain?: boolean;
  status?: string;
}

export interface AuditLogRecord {
  id?: string;
  tenantId: string;
  userId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt?: string;
}

export interface LoginResponse {
  user: AuthUser;
  tenant: {
    tenantId: string;
    name: string;
  };
}

export interface SessionPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
  branchIds: string[];
  email: string;
}

// ============================================================================
// Source Data Contracts (Feature 2: src_customers, src_customerEvents, src_orders)
// Spec p10, p24 - Date-only, Minor Units (paise), Encrypted Phones
// ============================================================================

export interface DateOnly {
  month: number; // 1-12
  day: number;   // 1-31
}

export interface CustomerDestination {
  encryptedPhone?: string; // Stored in backend DB, omitted in staff UI responses
  destinationHash: string; // HMAC-SHA256 for contact reservation & duplicate detection
  masked: string;          // Safe masked phone (e.g. "+91 98*** **210")
  verified: boolean;
  version: number;
  verificationLevel?: DestinationVerificationLevel;
  verifiedAt?: string | Date | null;
  verificationMethod?: DestinationVerificationMethod;
}

export interface CustomerConsent {
  marketingOptIn: boolean;
  channelSuppressed: boolean;
  consentCapturedAt?: string | Date | null;
  consentSource?: ConsentSource;
}

export interface CustomerPreferences {
  // --- Existing single-value fields (kept for backwards compatibility) ---
  weave?: string;
  budgetMaxPaise?: number; // Integer minor units (paise)
  size?: string;
  colour?: string;
  // --- F26 additive array fields (NEVER inferred; must be CUSTOMER_DECLARED|STAFF_RECORDED|IMPORTED|MOCK) ---
  weaves?: string[];
  colourFamilies?: string[];
  sizes?: string[];
  categories?: string[];  // stated interest categories (controlled PRODUCT_CATEGORIES)
  // --- F26 provenance ---
  source?: 'CUSTOMER_DECLARED' | 'STAFF_RECORDED' | 'IMPORTED' | 'MOCK' | 'INFERRED';
  preferencesVersion?: number;
  updatedAt?: string | Date | null;
}

export interface SourceCustomer {
  id?: string;
  _id?: string;
  tenantId: string;
  customerId: string;
  firstName: string;
  destination: CustomerDestination;
  birthday: DateOnly | null;
  consent: CustomerConsent;
  preferences: CustomerPreferences;
  tags: string[];
  status: string;
  branchId: string;
  deletedAt: string | Date | null;
  version: number;
  language: string;
  isLive?: boolean;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface SourceCustomerEvent {
  id?: string;
  _id?: string;
  tenantId: string;
  customerId: string;
  eventId: string;
  type: string; // e.g. 'anniversary'
  month: number;
  day: number;
  label?: string;
  version: number;
  deletedAt?: string | Date | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface OrderLine {
  lineId: string;
  itemRef?: string;
  name?: string;
  quantity?: number;
  qty?: number;
  pricePaise?: number; // Integer minor units
  productId?: string | null;
  variantId?: string | null;
  returnedQty?: number;
  lineNetPaise?: number;
}

export interface SourceOrder {
  id?: string;
  _id?: string;
  tenantId: string;
  orderId: string;
  orderNumber?: string | null;
  customerId?: string | null;
  status: 'COMPLETED' | 'PENDING' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | string;
  paid: boolean;
  netPaise: number; // Integer minor units (e.g. 580000 = Rs 5,800)
  grossPaise?: number | null;
  refundedPaise?: number | null;
  occasionRef?: string | null; // e.g. 'birthday:2027'
  enquiryRef?: string | null; // e.g. 'enquiry:enq_001'
  outfitRef?: string | null; // e.g. 'outfit:ord_040'
  lines: OrderLine[];
  entityVersion: number;
  completedAt: string | Date | null;
  branchId?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export type EnquiryChannel = 'IN_STORE' | 'PHONE' | 'WHATSAPP' | 'OTHER';
export type EnquiryStatus = 'OPEN' | 'RESOLVED' | 'CLOSED' | 'CANCELLED' | 'DELETED';

export interface SourceEnquiry {
  enquiryId: string;
  tenantId: string;
  customerId?: string | null;
  branchId?: string | null;
  channel: EnquiryChannel;
  status: EnquiryStatus;
  staffTakeover: boolean;
  itemRef?: {
    productId: string;
    variantId?: string | null;
  } | null;
  createdAt: Date;
  lastCustomerInteractionAt: Date;
  updatedAt: Date;
  entityVersion: number;
  source: 'MOCK';
}

export type ProductStatus = 'ACTIVE' | 'DISCONTINUED';

export interface ProductVariant {
  variantId: string;
  label: string;
  sellableQty: number;
  version: number;
  /** Optional per-variant attributes for matching (size, colourFamily). F26. */
  attributes?: {
    size?: string;
    colourFamily?: string;
  };
}

export interface SourceProduct {
  id?: string;
  _id?: string;
  tenantId: string;
  productId: string;
  name: string;
  category?: ProductCategory;
  colourFamily?: ColourFamily | null;
  weave?: Weave | null;
  pricePaise?: number;
  status: ProductStatus;
  entityVersion: number;
  variants: ProductVariant[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CustomerFilter {
  status?: string;
  marketingOptIn?: boolean;
  channelSuppressed?: boolean;
  branchId?: string;
  hasBirthday?: boolean;
  birthdayMonth?: number;
  birthdayDay?: number;
  isLive?: boolean;
  search?: string;
  includeDeleted?: boolean;
  afterCustomerId?: string;
}

export interface CustomerListResponse {
  tenantId: string;
  customers: SourceCustomer[];
  total: number;
  limit: number;
  skip: number;
}

// ============================================================================
// WhatsApp Templates & Connection Contracts (Spec p3, p7, p26, p27)
// Read-only to application code; supplied by Meta & Integration Developer
// ============================================================================

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'UNKNOWN';
export type TemplateSource = 'META_PROVIDED' | 'DUMMY';
export type FixOwner = 'INTEGRATION_DEVELOPER' | 'BOUTIQUE_OWNER' | 'SYSTEM_ADMIN' | 'PRODUCT_MANAGER';

export interface TemplateVariable {
  index: number;
  name: string;
  type: string;
  sample: string;
}

export interface SourceTemplate {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: string;
  bodyText: string | null;
  variables: TemplateVariable[];
  revision: number;
  sendable: boolean;
  source: TemplateSource;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface SourceConnection {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  wabaId: string;
  secretRef: string; // Environment variable name, NEVER the token secret
  graphApiVersion: string;
  status: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface ReadinessFailure {
  code: string;
  message: string;
  fixOwner: FixOwner;
}

export interface ReadinessCheckItem {
  passed: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface IntegrationReadinessReport {
  ready: boolean;
  tenantId: string;
  connection: {
    id: string;
    phoneNumberId: string;
    wabaId: string;
    secretRef: string;
    graphApiVersion: string;
    status: string;
  } | null;
  checks: {
    connectionExists: ReadinessCheckItem;
    tokenPresent: ReadinessCheckItem;
    allowlistConfigured: ReadinessCheckItem;
    hasSendableTemplate: ReadinessCheckItem;
  };
  sendableTemplatesCount: number;
  totalTemplatesCount: number;
  failures: ReadinessFailure[];
  notice: string;
  timestamp: string;
}

export interface TemplateCatalogueResponse {
  templates: SourceTemplate[];
  total: number;
  sendableCount: number;
  metaProvidedCount: number;
  dummyCount: number;
}

// ============================================================================
// Campaign Settings Contracts (Feature 4 - Spec p7, p17, p18, p26)
// Tenant-level policies, send hours, blackouts, marketing caps & defaults
// ============================================================================

export interface SendingHours {
  start: string; // HH:mm inclusive, e.g. "10:00"
  end: string;   // HH:mm exclusive, e.g. "19:00"
}

export interface HolidayItem {
  date: string; // YYYY-MM-DD
  name: string; // Holiday name
}

export interface MarketingCaps {
  daily: number;  // Max 1 per 24h
  weekly: number; // Max 3 per 7d
}

export interface PriorityAllowlistRanges {
  birthday: number;        // default 80
  anniversary: number;     // default 80
  wedding: number;         // default 70
  requestedStock: number;  // default 60
  festival: number;        // default 50
  winBack: number;         // default 30
  [key: string]: number;
}

export interface CampaignSettings {
  id?: string;
  _id?: string;
  tenantId: string;
  version: number;
  timezone: string; // Valid IANA zone, e.g. "Asia/Kolkata"
  allowedSendingHours: SendingHours;
  blackoutDates: string[]; // YYYY-MM-DD array
  holidays: HolidayItem[];
  marketingCaps: MarketingCaps;
  serviceContactSpacingHours: number; // default 24
  outageGraceHours: number; // default 2
  resumePolicy: 'FUTURE_ONLY';
  importPolicy: 'FUTURE_ONLY';
  priorityAllowlistRanges: PriorityAllowlistRanges;
  defaultPhoneCountry?: string;
  minDestinationVerification?: DestinationVerificationLevel;
  bookingLinkUrl?: string | null;
  isPaused: boolean;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface UpdateCampaignSettingsInput {
  expectedVersion: number;
  timezone?: string;
  allowedSendingHours?: SendingHours;
  blackoutDates?: string[];
  holidays?: HolidayItem[];
  marketingCaps?: Partial<MarketingCaps>;
  serviceContactSpacingHours?: number;
  outageGraceHours?: number;
  resumePolicy?: 'FUTURE_ONLY';
  importPolicy?: 'FUTURE_ONLY';
  priorityAllowlistRanges?: Partial<PriorityAllowlistRanges>;
  defaultPhoneCountry?: string;
  minDestinationVerification?: DestinationVerificationLevel;
  bookingLinkUrl?: string | null;
  isPaused?: boolean;
}

// ============================================================================
// Campaign Management & Draft Engine Contracts (Feature 5 - Spec p5-8, p20-26)
// ============================================================================

export interface TemplateRef {
  id: string;
  revision: number;
  language: string;
}

export type BindingValue =
  | string
  | {
      source: AllowedBindingSource | string;
      value?: string;
      fallbackLiteral?: string;
    };

export interface DelaySpec {
  unit: 'HOURS' | 'DAYS';
  value: number;
}

export interface OfferRef {
  offerId: string;
  version?: number;
}

export interface CreditRef {
  selector?: 'BY_SOURCE_ORDER' | 'BY_CREDIT_ID';
  reason?: string;
  creditId?: string;
  version?: number;
}

export interface SourceCredit {
  id?: string;
  _id?: string;
  creditId: string;
  tenantId: string;
  customerId: string;
  type: 'POINTS' | 'CASHBACK';
  unit: 'POINTS' | 'PAISE';
  amount: number;
  originalAmount: number;
  issuedAt: Date;
  expiresAt: Date;
  status: 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'REVOKED';
  reason: string;
  sourceOrderId?: string | null;
  entityVersion: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CampaignStep {
  stepId: string;
  stepName?: string;
  kind?: 'EVENT_DELAY' | 'ANNUAL_DATE' | 'DATE_OFFSET' | 'POST_EXPIRY';
  offsetDays?: number;
  localTime?: string; // HH:mm format
  delay?: DelaySpec;
  delayValue?: number;
  delayUnit?: 'HOURS' | 'DAYS';
  delayHours?: number;
  acknowledgeSpecDeviation?: boolean;
  outsideHoursPolicy?: 'DEFER_NEXT_DAY' | 'SKIP';
  maxDeferralHours?: number;
  offerRef?: OfferRef;
  creditRef?: CreditRef;
  prerequisite?: Prerequisite;
  templateRef: TemplateRef | null;
  bindings: Record<string, BindingValue>;
  stopOnReply?: boolean;
  stopOnGoal?: boolean;
  maxLatenessMinutes: number;
  relativeToAnchorHours?: number;
}

export interface CampaignTrigger {
  type:
    | 'ANNUAL_DATE'
    | 'INACTIVITY_THRESHOLD'
    | 'EVENT_DELAY'
    | 'CREDIT_EXPIRY'
    | 'CUSTOMER_EVENT_DATE'
    | 'ENQUIRY_EVENT_DELAY'
    | 'ORDER_EVENT_DELAY'
    | 'REQUEST_STOCK_AVAILABLE'
    | 'FULFILMENT_MILESTONE'
    | 'PRODUCTION_MILESTONE';
  field?: string; // 'customer.birthday' | 'customer.event'
  occasionKind?: 'GIFT' | 'WEDDING';
  fulfillmentLeadDays?: number;
  leapDayPolicy?: LeapDayPolicy; // 'FEB_28' | 'MAR_01' | 'LEAP_ONLY'
  thresholdDays?: number; // e.g. 90 or 180 for INACTIVITY_THRESHOLD
  category?: string; // optional category for INACTIVITY_THRESHOLD
  ruleId?: string; // default 'default' for INACTIVITY_THRESHOLD
  anchor?: 'FIRST_QUALIFYING_ORDER' | 'CREDIT_ISSUED' | 'CREDIT_EXPIRED_AT' | string;
  reasonFilter?: string[];
  unitFilter?: 'POINTS' | 'PAISE';
  amountGte?: number;
  milestone?: string;
  fulfilmentFilter?: any;
  usefulForDays?: number;
  partialReadyTemplateRef?: any;
}

export interface AudienceRulePredicate {
  field: AllowedAudienceField;
  op: AllowedAudienceOperator;
  value: any;
}

export interface AudienceRules {
  all?: AudienceRulePredicate[];
  any?: AudienceRulePredicate[];
  none?: AudienceRulePredicate[];
}

export type CampaignAudience =
  | {
      mode: 'ALL_ELIGIBLE';
      rules?: AudienceRules;
    }
  | {
      mode: 'CUSTOM_RULES';
      rules: AudienceRules;
    };

export interface CampaignGoal {
  type: string;
}

export interface DryRunStepPlan {
  stepId: string;
  stepName: string;
  offsetDays: number;
  localDate: string;
  localTime: string;
  timezone: string;
  dueAtUtc: string | Date;
  expiresAtUtc: string | Date;
  status: 'SCHEDULED' | 'SKIPPED_ELAPSED' | 'SKIPPED_EXPIRY';
  skipReason?: string;
  renderedMessage: string;
  templateId: string;
  templateName: string;
}

export interface SampleRecipientPlan {
  customerId: string;
  customerName: string;
  maskedPhone: string;
  occurrenceId: string;
  occasionLocalDate: string;
  matchExplanation: string;
  firstLocalDate: string;
  firstDueAtUtc: string | Date;
  steps: DryRunStepPlan[];
}

export interface ExcludedSample {
  customerId: string;
  customerName: string;
  primaryReason: string;
  details?: string;
}

export interface CampaignDryRun {
  id?: string;
  _id?: string;
  dryRunId: string;
  tenantId: string;
  campaignId: string;
  draftVersion: number;
  draftFingerprint: string;
  counts: {
    scanned: number;
    eligible: number;
    excluded: number;
  };
  reasonBreakdown: Record<string, number>;
  samplePlans: SampleRecipientPlan[];
  excludedSamples: ExcludedSample[];
  evaluatedAt: string | Date;
  evaluatedBy?: string;
  isStale?: boolean;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CampaignVersion {
  id?: string;
  _id?: string;
  tenantId: string;
  campaignId: string;
  version: number;
  name: string;
  industry: string;
  purpose: 'MARKETING';
  trigger: CampaignTrigger;
  timezone: string;
  audience: CampaignAudience;
  goal: CampaignGoal;
  steps: CampaignStep[];
  priority: number;
  resumePolicy: 'FUTURE_ONLY';
  importPolicy: 'FUTURE_ONLY';
  enabledBranches: string[];
  isPublished?: boolean;
  bindingsSchemaVersion?: number;
  startAt?: string | Date | null;
  scope?: CampaignScope;
  schemaVersion?: number;
  minFirstOrderNetPaise?: number;
  usefulForDays?: number;
  goalMode?: string;
  requireItem?: boolean;
  pairing?: CompleteOutfitPairingConfig;
  minDaysBetweenEnrollments?: number;
  activatedBy?: string | null;
  activatedAt?: string | Date | null;
  reviewFingerprint?: string | null;
  nextEvaluationAt?: string | Date | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface ActivateCampaignResponse {
  campaign: Campaign;
  activeVersion: CampaignVersion;
  nextEvaluationAt: string | Date;
  message: string;
  warnings?: string[];
}

export interface PublishRevisionInput {
  expectedVersion?: number;
}

export interface PublishRevisionResponse {
  campaign: Campaign;
  activeVersion: CampaignVersion;
  nextEvaluationAt: string | Date;
  message: string;
  warnings?: string[];
}

export interface CampaignDetailResponse {
  campaign: Campaign;
  draft: CampaignVersion | null;
  activeVersion: CampaignVersion | null;
  versions?: CampaignVersion[];
  controlGate: {
    pauseGeneration: number;
    version: number;
  };
  oldVersionEnrollmentCounts: number;
}


export interface Campaign {
  id?: string;
  _id?: string;
  campaignId: string;
  tenantId: string;
  name: string;
  presetId: string;
  status: CampaignStatus;
  activeVersionId: string | null;
  draftVersion: number;
  pauseGeneration: number;
  enabledBranches: string[];
  startAt?: string | Date | null;
  activatedAt?: string | Date | null;
  endAt?: string | Date | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CampaignControlGate {
  tenantId: string;
  campaignId: string;
  pauseGeneration: number;
  version: number;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CampaignValidationItem {
  fieldPath: string;
  message: string;
  code?: string;
  resolutionOwner: FixOwner;
}

export interface CampaignValidationReport {
  valid: boolean;
  errors: CampaignValidationItem[];
  warnings: CampaignValidationItem[];
}

export interface CampaignPreset {
  id: string;
  name: string;
  description: string;
  triggerFamily: string;
  implemented: boolean;
  category: string;
  isAlias?: boolean;
  defaults?: Partial<CampaignVersion>;
}

export interface IdempotencyRecord {
  tenantId: string;
  key: string;
  method: string;
  path: string;
  statusCode: number;
  responseBody: unknown;
  createdAt?: string | Date;
}

export interface CampaignGoalEvent {
  id?: string;
  goalEventId: string;
  tenantId: string;
  enrollmentId?: string | null;
  occurrence?: string | null;
  customerId?: string | null;
  campaignId?: string | null;
  source: string;
  orderRef?: string | null;
  cause?: string | null;
  supportingRecord?: string | null;
  recordedBy: string;
  at: string | Date;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CampaignEnrollment {
  id?: string;
  enrollmentId: string;
  enrollmentKey: string;
  tenantId: string;
  campaignId: string;
  campaignVersionId: string;
  campaignVersion: number;
  customerId: string;
  occurrenceId: string;
  sourceRef: {
    type: string;
    id: string;
    version: number;
  };
  occasionLocalDate: string;
  planRevision: number;
  status: EnrollmentStatus;
  scope?: CampaignScope;
  anchorOrderId?: string | null;
  replyHoldAt?: string | Date | null;
  replyAttribution?: 'CAMPAIGN' | 'NOT_CAMPAIGN_CONSERVATIVE' | null;
  replyContextMessageId?: string | null;
  lastReplyHoldAt?: string | Date | null;
  holdResolvedAt?: string | Date | null;
  holdResolvedBy?: string | null;
  holdResolutionCause?: string | null;
  goalReachedAt?: string | Date | null;
  goalEventId?: string | null;
  goalOrderRef?: string | null;
  goalSource?: string | null;
  orderRef?: string | null;
  matchExplanation?: string;
  correctionGroupId?: string | null;
  anchorAt?: string | Date | null;
  eventId?: string;
  occasionKind?: 'GIFT' | 'WEDDING' | string;
  eventDateSnapshot?: string;
  dateHistory?: Array<{
    at: string | Date;
    oldDate: string;
    newDate: string;
    oldVersion: number;
    newVersion: number;
  }>;
  stopReason?: string | null;
  stoppedAt?: string | Date | null;
  exclusionReason?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface ExecutionAttempt {
  attemptId: string;
  attemptNumber: number;
  attemptedAt: string | Date;
  state: string;
  providerMessageId?: string | null;
  errorCategory?: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
}

export interface CampaignExecution {
  id?: string;
  executionId: string;
  executionKey: string;
  tenantId: string;
  campaignId: string;
  enrollmentId: string;
  stepId: string;
  stepName?: string;
  dueAt: string | Date;
  originalDueAt: string | Date;
  rawDueAt?: string | Date | null;
  adjustedDueAt?: string | Date | null;
  expiresAt: string | Date;
  latestUsefulAt?: string | Date | null;
  usefulUntilReason?: string | null;
  delaySpec?: DelaySpec | null;
  deferralReason?: string | null;
  offerRef?: OfferRef | null;
  localDate: string;
  localTime: string;
  timezone: string;
  planRevision: number;
  state: ExecutionState;
  skipReason?: string | null;
  prerequisite: Prerequisite;
  templateRef?: {
    id: string;
    revision: number;
    language: string;
  } | null;
  deliveryIntentId?: string | null;
  deliveryIntent?: CampaignDeliveryIntent | null;
  providerMessageId?: string | null;
  lastErrorCategory?: string | null;
  retryAt?: string | Date | null;
  attemptCount?: number;
  attempts?: ExecutionAttempt[];
  lease?: {
    token: string | null;
    until: string | Date | null;
  };
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CampaignDeliveryIntent {
  id?: string;
  _id?: string;
  deliveryIntentId: string;
  tenantId: string;
  campaignId: string;
  enrollmentId: string;
  executionId: string;
  deliveryKey: string;
  connectionId: string;
  recipientVersion: number;
  encryptedRecipient?: string;
  maskedRecipient: string;
  templateRef: {
    id: string;
    revision: number;
    language: string;
  };
  parameters: Record<string, string | number>;
  payloadHash: string;
  state: string; // 'PREPARED_DRY' | 'SUBMITTING' | 'DISPATCHED' | 'PROVIDER_ACCEPTED' | 'FAILED' | 'BLOCKED_STALE_INTENT' | 'OUTCOME_UNKNOWN'
  attemptId: string;
  providerMessageId?: string | null;
  attempts?: ExecutionAttempt[];
  lastErrorCategory?: string | null;
  retryAt?: string | Date | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CampaignCheckpoint {
  id?: string;
  tenantId: string;
  campaignId: string;
  type: string;
  lastCustomerId?: string | null;
  horizonStart?: string;
  horizonEnd?: string;
  status: CheckpointStatus;
  leaseToken?: string | null;
  leaseExpiresAt?: string | Date | null;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
  processedCount: number;
  enrolledCount: number;
  error?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface CampaignEventPayload<T = Record<string, unknown>> {
  schemaVersion: number;
  producer: string;
  eventId: string;
  tenantId?: string;
  type: string;
  entityId: string;
  entityVersion: number;
  occurredAt: string | Date;
  receivedAt?: string | Date;
  customerId?: string;
  data: T;
}

export interface CampaignEventInboxItem {
  id?: string;
  _id?: string;
  tenantId: string;
  producer: string;
  eventId: string;
  type: string;
  schemaVersion: number;
  entityId: string;
  entityVersion: number;
  customerId?: string;
  occurredAt: Date | string;
  receivedAt: Date | string;
  data: Record<string, unknown>;
  status: EventInboxStatus;
  quarantineReason?: string;
  quarantineDetails?: Record<string, unknown>;
  processedAt?: Date | string;
  processedMarker?: {
    processedAt: Date | string;
    cursor?: number;
    effectsSummary?: string;
    affectedCount?: number;
  };
  attempts: number;
  lastError?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface CustomerFacts {
  tenantId: string;
  customerId: string;
  orderCount: number;
  totalSpendPaise: number;
  lastOrderAt?: Date | string | null;
  lastOrderId?: string | null;
  lastQualifyingPurchaseAt?: Date | string | null;
  lastQualifyingPurchaseOrderId?: string | null;
  lastQualifyingOrderId?: string | null;
  aggregateVersion: number;
  authoritativeSourceVersions?: {
    customerVersion?: number;
    orderVersion?: number;
    preferencesVersion?: number;
  };
  nextEvaluationAt?: Date | string | null;
  categoryPurchases?: Record<string, { lastQualifyingOrderId: string; lastQualifyingPurchaseAt: Date | string }>;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface DelayReasonItem {
  reason: string;
  count: number;
}

export interface PrimaryReasonItem {
  reason: string;
  count: number;
  category: 'SKIPPED' | 'CANCELLED' | 'EXPIRED';
}

export interface StepFunnelItem {
  stepId: string;
  stepName: string;
  scheduled: number;
  accepted: number;
  delivered: number;
  read: number;
  skipped: number;
  cancelled: number;
}

export interface AttributedOrder {
  orderId: string;
  customerId: string;
  status: string;
  paid: boolean;
  netPaise: number;
  netRupees: number;
  occasionRef: string | null;
  attributionSource: 'GOAL_EVENT' | 'ENROLLMENT_LINK' | 'OCCASION_REF';
  supportingRecord?: string | null;
  completedAt: string | null;
}

export interface CampaignReport {
  campaignId: string;
  campaignName: string;
  status: string;
  presetId?: string;
  statedAt: string;
  eligible: {
    count: number;
    statedAt: string | null;
  };
  enrollments: {
    total: number;
    uniqueCustomers: number;
  };
  executionCounts: {
    total: number;
    scheduled: number;
    deferred: number;
    nextScheduledDueAt: string | null;
    delayReasons: DelayReasonItem[];
    skipped: number;
    cancelled: number;
    expired: number;
    failed: number;
    outcomeUnknown: number;
    primaryReasons: PrimaryReasonItem[];
  };
  deliveryEvidence: {
    accepted: number;
    sent: number;
    delivered: number;
    read: number;
    notice: string;
  };
  repliesAndHolds: {
    totalHeldOrReplied: number;
    exactCampaignReplies: number;
    conservativeHolds: number;
    currentlyOnHold: number;
    resolvedHolds: number;
  };
  goalCompletions: {
    total: number;
    orderOccasion: number;
    staffManual: number;
    details: Array<{
      goalEventId: string;
      source: string;
      orderRef?: string | null;
      cause?: string | null;
      at: string;
    }>;
  };
  attribution: {
    model: string;
    assumptionNotice?: string;
    orderCount: number;
    totalNetSalesPaise: number;
    totalNetSalesRupees: number;
    refundsCount: number;
    refundedPaise: number;
    orders: AttributedOrder[];
  };
  unassignedStoreOrders: {
    orderCount: number;
    netSalesPaise: number;
    netSalesRupees: number;
  };
  stepFunnel: StepFunnelItem[];
}

export interface CustomerTimelineStep {
  executionId: string;
  stepId: string;
  stepName: string;
  state: string;
  skipReason: string | null;
  plannedDueAt: string;
  plannedLocalDate: string;
  plannedLocalTime: string;
  timezone: string;
  actualDispatchedAt: string | null;
  actualDeliveredAt: string | null;
  actualReadAt: string | null;
  template: {
    id: string;
    revision: number;
    language: string;
  } | null;
  statusHistory: Array<{
    state: string;
    timestamp: string;
    details?: string;
  }>;
  providerMessageId: string | null;
  lastErrorCategory: string | null;
  attemptsCount: number;
}

export interface CustomerTimelineReport {
  customerId: string;
  customerName: string;
  maskedPhone: string;
  tenantId: string;
  campaignId: string;
  campaignName: string;
  enrollment: {
    enrollmentId: string;
    occurrenceId: string;
    occasionLocalDate: string;
    status: string;
    matchExplanation: string;
    createdAt: string;
    replyHoldAt: string | null;
    replyAttribution: string | null;
    lastReplyHoldAt: string | null;
    holdResolvedAt: string | null;
    holdResolutionCause: string | null;
    goalReachedAt: string | null;
    goalSource: string | null;
    goalOrderRef: string | null;
  };
  steps: CustomerTimelineStep[];
  linkedOrders: AttributedOrder[];
}

export interface CampaignTombstone {
  id?: string;
  _id?: string;
  tenantId: string;
  type: 'ENROLLMENT' | 'EXECUTION';
  key: string;
  campaignId: string;
  customerId: string;
  occurrenceId?: string | null;
  stepId?: string | null;
  tombstonedAt: string | Date;
  originalId: string;
  retentionReason: string;
  metadata?: Record<string, any>;
  createdAt?: string | Date;
}

export interface ReconciliationResult {
  checkpointId: string;
  tenantId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'COMPLETED' | 'FAILED';
  counts: {
    stalledLeasesReleased: number;
    orphanedIntentsCleaned: number;
    expiredStepsMarked: number;
    missedEventsProcessed: number;
    totalScanned: number;
  };
  details: string[];
}

export interface OperationalMetrics {
  tenantId: string;
  generatedAt: string;
  plannerLag: {
    maxLagMs: number;
    maxLagFormatted: string;
    overdueCampaignsCount: number;
    campaigns: Array<{
      campaignId: string;
      campaignName: string;
      nextEvaluationAt: string;
      lagMs: number;
    }>;
  };
  dueStepAge: {
    maxAgeMs: number;
    maxAgeFormatted: string;
    avgAgeMs: number;
    dueStepCount: number;
  };
  skippedReasons: Array<{
    reason: string;
    count: number;
    percentage: number;
  }>;
  eventBacklog: {
    pendingCount: number;
    oldestPendingAgeMs: number;
    quarantinedCount: number;
  };
  outcomeUnknownCount: number;
  templateBlocks: {
    blockedExecutionsCount: number;
    affectedCampaigns: string[];
  };
  stalledCheckpoints: Array<{
    campaignId: string;
    type: string;
    status: string;
    stalledDurationMs: number;
    leaseExpiresAt: string | null;
  }>;
  tenantFairProcessing: {
    activeReservations: number;
    rolling24hContacts: number;
    fairShareIndex: number;
  };
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  alerts: Array<{
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    component: string;
    message: string;
  }>;
}


export interface SourceOffer {
  id?: string;
  _id?: string;
  offerId: string;
  tenantId: string;
  kind: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE' | 'SELECTED_STOCK';
  amountPaise: number;
  name?: string;
  publishedAt?: string | Date | null;
  discount?: {
    type: 'PERCENT_OFF' | 'FLAT_OFF' | 'SPECIAL_PRICE';
    percent?: number;
    flatOffPaise?: number;
  };
  terms?: string;
  tags?: string[];
  branchIds?: string[];
  items?: Array<{
    productId: string;
    variantIds?: string[] | null;
    offerPricePaise?: number | null;
    position: number;
  }>;
  validFrom: string | Date;
  validUntil: string | Date;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'WITHDRAWN' | 'EXPIRED';
  version: number;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface WelcomeSummaryReport {
  campaignId: string;
  tenantId: string;
  enrollments: number;
  excludedCount: number;
  excludedByReason: Record<string, number>;
  scheduled: number;
  deferredCount: number;
  deferredByReason: Record<string, number>;
  skippedCount: number;
  skippedByReason: Record<string, number>;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  repliesAndHolds: {
    totalHeldOrReplied: number;
    exactCampaignReplies: number;
    conservativeHolds: number;
    currentlyOnHold: number;
    resolvedHolds: number;
  };
  note: string;
}

export interface CompleteOutfitPairingConfig {
  anchorCategories: ProductCategory[];
  complementMap: Record<string, ProductCategory[]>;
  colourMatch: ColourMatchMode;
  requireSameWeave: boolean;
  budgetAware: boolean;
  alreadyOwnedLookbackDays: number;
  suppressIfCategoryInOrder: boolean;
}

export interface CompleteOutfitSummaryReport {
  campaignId: string;
  tenantId: string;
  qualifyingOrdersSeen: number;
  enrollments: number;
  excludedCount: number;
  excludedByReason: Record<string, number>;
  scheduled: number;
  deferredCount: number;
  deferredByReason: Record<string, number>;
  skippedCount: number;
  skippedByReason: Record<string, number>;
  staleBlocks: number;
  sent: number;
  accepted: number;
  delivered: number;
  read: number;
  repliesAndHolds: {
    totalHeldOrReplied: number;
    exactCampaignReplies: number;
    conservativeHolds: number;
    currentlyOnHold: number;
    resolvedHolds: number;
  };
  goalCompletions: {
    total: number;
    byEvidenceType: Record<string, number>;
  };
  observationalPurchases: {
    count: number;
    note: string;
  };
}

'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { AppShell } from '../../../components/AppShell';
import { useAuth } from '../../../context/AuthContext';
import { ActivationModal } from '../../../components/ActivationModal';
import { CampaignDetailView } from '../../../components/CampaignDetailView';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  Save,
  RotateCcw,
  Plus,
  Trash2,
  Clock,
  Layers,
  Sparkles,
  Loader2,
  Lock,
  Calendar,
  Gift,
  Info,
  Check,
  AlertCircle,
  FileText,
  Play,
  Users,
  Filter,
  Sliders,
  CheckCircle,
  XCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  X,
  Scissors,
} from 'lucide-react';
import {
  Campaign,
  CampaignVersion,
  CampaignStep,
  CampaignValidationReport,
  CampaignValidationItem,
  SourceTemplate,
  BranchInfo,
  CampaignStatus,
  CampaignDryRun,
  AudienceRulePredicate,
  ActivateCampaignResponse,
  PublishRevisionResponse,
  ALLOWED_BINDING_SOURCES,
  ALLOWED_AUDIENCE_FIELDS,
  ALLOWED_AUDIENCE_OPERATORS,
} from '@grovastra/shared';

const WIZARD_STEPS = [
  { id: 1, key: 'trigger', label: 'Trigger' },
  { id: 2, key: 'audience', label: 'Audience' },
  { id: 3, key: 'messages', label: 'Messages' },
  { id: 4, key: 'rules', label: 'Sending Rules' },
  { id: 5, key: 'review', label: 'Review & Validate' },
];

export interface SamplePreviewCustomer {
  id: string;
  label: string;
  badge: string;
  firstName: string;
  maskedPhone: string;
  tags: string[];
  branch: string;
}

const SAMPLE_PREVIEW_CUSTOMERS: SamplePreviewCustomer[] = [
  {
    id: 'cus_preview_1',
    label: 'Standard Patron',
    badge: 'Standard Profile',
    firstName: 'Lakshmi Devi',
    maskedPhone: '+91 98*** 43210',
    tags: ['vip', 'regular'],
    branch: 'Flagship Store',
  },
  {
    id: 'cus_preview_2',
    label: 'No Name Recorded',
    badge: 'Empty Name Fallback',
    firstName: '',
    maskedPhone: '+91 91*** 00031',
    tags: ['walk_in', 'mapping-test'],
    branch: 'Flagship Store',
  },
  {
    id: 'cus_preview_3',
    label: 'Whitespace & Newlines',
    badge: 'Sanitization Profile',
    firstName: '  Priya Rao \n',
    maskedPhone: '+91 91*** 00032',
    tags: ['mapping-test'],
    branch: 'Heritage Lane',
  },
  {
    id: 'cus_preview_4',
    label: 'Unicode & Emoji',
    badge: 'Unicode NFC Profile',
    firstName: 'Sunita 🌸',
    maskedPhone: '+91 91*** 00034',
    tags: ['mapping-test'],
    branch: 'Flagship Store',
  },
  {
    id: 'cus_preview_5',
    label: 'Ayesha Khan',
    badge: 'Boutique Patron',
    firstName: 'Ayesha Khan',
    maskedPhone: '+91 91*** 00016',
    tags: ['loyal', 'annual_vip'],
    branch: 'Heritage Lane',
  },
];

function renderLivePreviewText(
  template: SourceTemplate | undefined,
  bindings: Record<string, any> = {},
  customer: { firstName: string },
  shopName: string = 'Sample Boutique',
  offerAmount: string = '50'
): { renderedText: string; usedFallback: boolean; paramValues: Record<string, string>; problems: string[] } {
  if (!template) {
    return { renderedText: 'No template selected.', usedFallback: false, paramValues: {}, problems: [] };
  }

  const variables = template.variables || [];
  if (variables.length === 0) {
    return {
      renderedText: template.bodyText || template.name,
      usedFallback: false,
      paramValues: {},
      problems: [],
    };
  }

  let usedFallback = false;
  const paramValues: Record<string, string> = {};
  const problems: string[] = [];

  for (const v of variables) {
    const key = String(v.index);
    const b = bindings[key];
    let source = 'customer.firstName';
    let literalVal = '';
    let fallbackVal = '';

    if (typeof b === 'string') {
      if (b.startsWith('literal:')) {
        source = 'literal';
        literalVal = b.replace('literal:', '');
      } else {
        source = b;
      }
    } else if (b && typeof b === 'object') {
      source = b.source || 'customer.firstName';
      literalVal = b.value || '';
      fallbackVal = b.fallbackLiteral || '';
    }

    let val = '';
    if (source === 'literal') {
      val = literalVal;
    } else if (source === 'customer.firstName') {
      const trimmed = customer.firstName.trim();
      if (trimmed) {
        val = trimmed;
      } else if (fallbackVal) {
        val = fallbackVal;
        usedFallback = true;
      } else {
        val = '{{MISSING_NAME}}';
        problems.push(`Variable {{${v.index}}} requires fallbackLiteral when customer name is empty`);
      }
    } else if (source === 'shop.displayName') {
      val = shopName;
    } else if (source === 'offer.amountRupees') {
      val = `₹${offerAmount}`;
    } else if (source === 'occasion.localDate') {
      val = '24 Oct 2026';
    } else if (source === 'order.firstOrderNumber') {
      val = 'ORD-1001';
    } else if (source === 'order.firstOrderDate') {
      val = '24 Oct 2026';
    } else if (source === 'credit.balanceDisplay') {
      val = '₹150';
    } else if (source === 'credit.expiryDate') {
      val = '31 Dec 2026';
    } else if (source === 'credit.daysToExpiry') {
      val = '14';
    } else if (source === 'event.name') {
      val = 'Exclusive Taj Trunk Show';
    } else if (source === 'event.date') {
      val = '20 Nov 2026';
    } else if (source === 'event.venue') {
      val = 'The Taj Mahal Palace, Mumbai';
    } else if (source === 'event.city') {
      val = 'Mumbai';
    } else if (source === 'event.rsvpLink') {
      val = 'https://rsvp.example.com/trunk-show';
    } else {
      val = `{{${v.index}}}`;
    }

    val = val.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (val.length > 200) {
      problems.push(`Variable {{${v.index}}} exceeds 200 character limit (${val.length} chars)`);
    }

    paramValues[key] = val;
  }

  let text = template.bodyText || '';
  if (!text) {
    text = `${template.name}: ` + Object.entries(paramValues).map(([k, v]) => `{{${k}}} = ${v}`).join(', ');
  } else {
    for (const [k, v] of Object.entries(paramValues)) {
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    }
  }

  return { renderedText: text, usedFallback, paramValues, problems };
}

export default function CampaignEditorPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const campaignId = params.id as string;

  const [activeStep, setActiveStep] = useState(1);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [draft, setDraft] = useState<CampaignVersion | null>(null);
  const [activeVersion, setActiveVersion] = useState<CampaignVersion | null>(null);
  const [versions, setVersions] = useState<CampaignVersion[]>([]);
  const [viewMode, setViewMode] = useState<'detail' | 'wizard'>('wizard');
  const [initialViewModeSet, setInitialViewModeSet] = useState(false);
  const [templates, setTemplates] = useState<SourceTemplate[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [offers, setOffers] = useState<Array<{ offerId: string; amountPaise: number; status: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving'>('saved');
  const [conflict, setConflict] = useState<{ expected: number; current: number } | null>(null);
  const [validationReport, setValidationReport] = useState<CampaignValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const [dryRun, setDryRun] = useState<CampaignDryRun | null>(null);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [expandedPlanIndex, setExpandedPlanIndex] = useState<number | null>(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activationSuccess, setActivationSuccess] = useState<{ message: string; nextEvaluationAt?: string } | null>(null);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [suggestionDiffModal, setSuggestionDiffModal] = useState<{
    open: boolean;
    diffs: Array<{
      stepIndex: number;
      stepName: string;
      templateId: string;
      templateName: string;
      variableIndex: number;
      variableName: string;
      currentSource: string;
      currentLiteral?: string;
      currentFallback?: string;
      suggestedSource: string;
      suggestedLiteral?: string;
      suggestedFallback?: string;
    }>;
    suggestedBindingsByStep: Record<number, Record<string, any>>;
  } | null>(null);
  const [previewCustomerIndex, setPreviewCustomerIndex] = useState(0);
  const [autoFillNotice, setAutoFillNotice] = useState<string | null>(null);

  // Complete Outfit Preview State (F24)
  const [outfitPreviewOrderId, setOutfitPreviewOrderId] = useState('order_saree_01');
  const [outfitPreviewLoading, setOutfitPreviewLoading] = useState(false);
  const [outfitPreviewData, setOutfitPreviewData] = useState<any | null>(null);
  const [outfitPreviewError, setOutfitPreviewError] = useState<string | null>(null);

  const runOutfitPreview = async () => {
    if (!outfitPreviewOrderId.trim() || !campaign) return;
    setOutfitPreviewLoading(true);
    setOutfitPreviewError(null);
    setOutfitPreviewData(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.campaignId}/complete-outfit/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: outfitPreviewOrderId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.error || 'Failed to simulate outfit matching');
      }
      setOutfitPreviewData(data);
    } catch (err: any) {
      setOutfitPreviewError(err?.message || 'Failed to run outfit preview');
    } finally {
      setOutfitPreviewLoading(false);
    }
  };

  // Matching Collection Preview State (F26)
  const [collectionPreviewReleaseId, setCollectionPreviewReleaseId] = useState('rel_mc_winter');
  const [collectionPreviewLoading, setCollectionPreviewLoading] = useState(false);
  const [collectionPreviewData, setCollectionPreviewData] = useState<any | null>(null);
  const [collectionPreviewError, setCollectionPreviewError] = useState<string | null>(null);
  const [stockOfferId, setStockOfferId] = useState('off_sp_percent');
  const [stockPreview, setStockPreview] = useState<any | null>(null);
  const [stockPreviewError, setStockPreviewError] = useState<string | null>(null);

  // Festival Collection Preview State (F28)
  const [festivalSeasonId, setFestivalSeasonId] = useState('season_fc_diwali');
  const [festivalPreview, setFestivalPreview] = useState<any | null>(null);
  const [festivalPreviewLoading, setFestivalPreviewLoading] = useState(false);
  const [festivalPreviewError, setFestivalPreviewError] = useState<string | null>(null);

  const runFestivalPreview = async () => {
    if (!campaign || !festivalSeasonId.trim()) return;
    setFestivalPreviewLoading(true);
    setFestivalPreviewError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.campaignId}/festival/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId: festivalSeasonId.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Unable to preview festival season');
      setFestivalPreview(payload);
    } catch (error) {
      setFestivalPreviewError(error instanceof Error ? error.message : 'Unable to preview festival season');
    } finally {
      setFestivalPreviewLoading(false);
    }
  };

  // Exhibition / Trunk Show Preview State (F29)
  const [exhibitionEventId, setExhibitionEventId] = useState('evt_ex_mumbai_2026');
  const [exhibitionPreview, setExhibitionPreview] = useState<any | null>(null);
  const [exhibitionPreviewLoading, setExhibitionPreviewLoading] = useState(false);
  const [exhibitionPreviewError, setExhibitionPreviewError] = useState<string | null>(null);

  const runExhibitionPreview = async () => {
    if (!campaign || !exhibitionEventId.trim()) return;
    setExhibitionPreviewLoading(true);
    setExhibitionPreviewError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.campaignId}/exhibition/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: exhibitionEventId.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Unable to preview exhibition event');
      setExhibitionPreview(payload);
    } catch (error) {
      setExhibitionPreviewError(error instanceof Error ? error.message : 'Unable to preview exhibition event');
    } finally {
      setExhibitionPreviewLoading(false);
    }
  };

  // Fitting / Alteration Preview State (F30)
  const [faPreviewType, setFaPreviewType] = useState<'appointment' | 'alteration'>('appointment');
  const [faAppointmentId, setFaAppointmentId] = useState('appt_fa_01');
  const [faJobId, setFaJobId] = useState('alt_fa_01');
  const [faPreview, setFaPreview] = useState<any | null>(null);
  const [faPreviewLoading, setFaPreviewLoading] = useState(false);
  const [faPreviewError, setFaPreviewError] = useState<string | null>(null);

  const runFaPreview = async () => {
    if (!campaign) return;
    setFaPreviewLoading(true);
    setFaPreviewError(null);
    try {
      const body =
        faPreviewType === 'appointment'
          ? { appointmentId: faAppointmentId.trim() }
          : { jobId: faJobId.trim() };
      const response = await fetch(`/api/campaigns/${campaign.campaignId}/fitting-alteration/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to preview fitting/alteration candidate');
      setFaPreview(payload);
    } catch (error) {
      setFaPreviewError(error instanceof Error ? error.message : 'Unable to preview fitting/alteration candidate');
    } finally {
      setFaPreviewLoading(false);
    }
  };

  const runCollectionPreview = async () => {
    if (!collectionPreviewReleaseId.trim() || !campaign) return;
    setCollectionPreviewLoading(true);
    setCollectionPreviewError(null);
    setCollectionPreviewData(null);

    try {
      const res = await fetch(
        `/api/campaigns/${campaign.campaignId}/collection-preview?releaseId=${encodeURIComponent(collectionPreviewReleaseId.trim())}`
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.message || 'Failed to run collection preview');
      }
      setCollectionPreviewData(data);
    } catch (err: any) {
      setCollectionPreviewError(err?.message || 'Failed to run collection preview');
    } finally {
      setCollectionPreviewLoading(false);
    }
  };

  const runStockPreview = async () => {
    if (!campaign || !stockOfferId.trim()) return;
    setStockPreviewError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.campaignId}/selected-stock/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerId: stockOfferId.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Unable to preview offer');
      setStockPreview(payload);
    } catch (error) {
      setStockPreviewError(error instanceof Error ? error.message : 'Unable to preview offer');
    }
  };

  // Route protection
  useEffect(() => {
    if (!authLoading && user && user.role === 'staff') {
      router.replace('/403');
    }
  }, [user, authLoading, router]);

  // Load campaign draft, templates, branches, and latest dry run
  const loadCampaignData = useCallback(async () => {
    if (!campaignId) return;

    try {
      setLoading(true);
      setErrorMsg(null);
      setConflict(null);

      const [cmpRes, tplRes, branchRes, dryRunRes, offersRes] = await Promise.all([
        fetch(`/api/campaigns/${campaignId}`),
        fetch('/api/approved-template-catalogue'),
        fetch('/api/tenant/branches'),
        fetch(`/api/campaigns/${campaignId}/dry-runs/latest`),
        fetch('/api/offers').catch(() => null),
      ]);

      if (!cmpRes.ok) {
        throw new Error('Failed to load campaign');
      }

      const cmpData = await cmpRes.json();
      setCampaign(cmpData.campaign);
      setDraft(cmpData.draft);
      if (offersRes && offersRes.ok) {
        const offData = await offersRes.json();
        setOffers(offData.offers || offData || []);
      }
      setActiveVersion(cmpData.activeVersion || null);
      setVersions(cmpData.versions || []);

      if (!initialViewModeSet) {
        if (['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(cmpData.campaign?.status)) {
          setViewMode('detail');
        } else {
          setViewMode('wizard');
        }
        setInitialViewModeSet(true);
      }

      if (tplRes.ok) {
        const tplData = await tplRes.json();
        setTemplates(tplData.templates || []);
      }

      if (branchRes.ok) {
        const branchData = await branchRes.json();
        setBranches(branchData.branches || []);
      }

      if (dryRunRes.ok) {
        const dryData = await dryRunRes.json();
        setDryRun(dryData);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Error loading campaign details');
    } finally {
      setLoading(false);
    }
  }, [campaignId, initialViewModeSet]);

  useEffect(() => {
    if (!authLoading && user && user.role !== 'staff') {
      loadCampaignData();
    }
  }, [authLoading, user, loadCampaignData]);

  // Save Draft with expectedVersion (Spec p26, C16)
  const saveDraft = async (dataToSave?: Partial<CampaignVersion>): Promise<boolean> => {
    if (!draft || !campaign) return false;

    try {
      setSaving(true);
      setSaveStatus('saving');
      setErrorMsg(null);
      setConflict(null);

      const isEventDelay =
        (dataToSave?.trigger ?? draft.trigger)?.type === 'EVENT_DELAY' ||
        (dataToSave?.trigger ?? draft.trigger)?.type === 'ORDER_EVENT_DELAY' ||
        (dataToSave?.trigger ?? draft.trigger)?.type === 'ENQUIRY_EVENT_DELAY';
      const stepsToSave = (dataToSave?.steps ?? draft.steps ?? []).map((s: any) => {
        const base: any = {
          stepId: s.stepId,
          stepName: s.stepName,
          prerequisite: s.prerequisite || 'NONE',
          templateRef: s.templateRef
            ? {
                id: s.templateRef.id,
                revision: s.templateRef.revision,
                language: s.templateRef.language,
              }
            : null,
          bindings: s.bindings || {},
          stopOnReply: Boolean(s.stopOnReply),
          stopOnGoal: Boolean(s.stopOnGoal),
          maxLatenessMinutes: s.maxLatenessMinutes || (isEventDelay ? 180 : 120),
        };

        if (isEventDelay) {
          const delayObj = s.delay || {
            unit: s.delayUnit || 'HOURS',
            value: typeof s.delayValue === 'number' ? s.delayValue : 1,
          };
          base.delay = {
            unit: delayObj.unit || 'HOURS',
            value: typeof delayObj.value === 'number' ? delayObj.value : 1,
          };
          base.outsideHoursPolicy = s.outsideHoursPolicy || 'DEFER_NEXT_DAY';
          base.maxDeferralHours = typeof s.maxDeferralHours === 'number' ? s.maxDeferralHours : 24;
          if (s.offerRef?.offerId) {
            base.offerRef = { offerId: s.offerRef.offerId };
          }
        } else {
          base.offsetDays = typeof s.offsetDays === 'number' ? s.offsetDays : 0;
          base.localTime = s.localTime || '10:00';
        }

        return base;
      });

      const audienceToSave = dataToSave?.audience ?? draft.audience;
      const cleanAudience = {
        mode: audienceToSave?.mode || 'ALL_ELIGIBLE',
        rules: audienceToSave?.rules || { all: [], any: [], none: [] },
      };

      const rawTrigger: any = dataToSave?.trigger ?? draft.trigger;
      let cleanTrigger: any;
      if (rawTrigger?.type === 'ORDER_EVENT_DELAY') {
        const anchor = rawTrigger.anchor || 'ORDER_COMPLETED_AT';
        cleanTrigger = {
          type: 'ORDER_EVENT_DELAY',
          anchor,
        };
      } else if (rawTrigger?.type === 'EVENT_DELAY') {
        const anchor = rawTrigger.anchor || 'FIRST_QUALIFYING_ORDER';
        cleanTrigger = {
          type: 'EVENT_DELAY',
          anchor,
        };
      } else if (rawTrigger?.type === 'INACTIVITY_THRESHOLD') {
        cleanTrigger = {
          type: 'INACTIVITY_THRESHOLD',
          thresholdDays: typeof rawTrigger.thresholdDays === 'number' ? rawTrigger.thresholdDays : 90,
          ruleId: rawTrigger.ruleId || 'default',
        };
      } else if (rawTrigger?.type === 'CUSTOMER_EVENT_DATE') {
        const occKind = rawTrigger.occasionKind || 'WEDDING';
        cleanTrigger = {
          type: 'CUSTOMER_EVENT_DATE',
          occasionKind: occKind,
          fulfillmentLeadDays:
            typeof rawTrigger.fulfillmentLeadDays === 'number'
              ? rawTrigger.fulfillmentLeadDays
              : (occKind === 'GIFT' ? 2 : 21),
        };
      } else {
        cleanTrigger = {
          type: 'ANNUAL_DATE',
          field: rawTrigger?.field || 'customer.birthday',
          leapDayPolicy: rawTrigger?.leapDayPolicy || 'FEB_28',
        };
      }

      const rawGoal: any = dataToSave?.goal ?? draft.goal;
      const cleanGoal = {
        type: rawGoal?.type || 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
      };

      const payload: any = {
        expectedVersion: draft.version,
        name: dataToSave?.name ?? draft.name,
        enabledBranches: dataToSave?.enabledBranches ?? draft.enabledBranches,
        timezone: dataToSave?.timezone ?? draft.timezone,
        trigger: cleanTrigger,
        audience: cleanAudience,
        goal: cleanGoal,
        steps: stepsToSave,
        priority: dataToSave?.priority ?? draft.priority,
        resumePolicy: dataToSave?.resumePolicy ?? draft.resumePolicy,
        importPolicy: dataToSave?.importPolicy ?? draft.importPolicy,
      };

      const draftScope = dataToSave?.scope ?? (draft as any).scope;
      if (draftScope !== undefined) {
        payload.scope = draftScope;
      }
      const draftMinPaise = dataToSave?.minFirstOrderNetPaise ?? (draft as any).minFirstOrderNetPaise;
      if (draftMinPaise !== undefined) {
        payload.minFirstOrderNetPaise = draftMinPaise;
      }
      const draftPairing = dataToSave?.pairing ?? (draft as any).pairing;
      if (draftPairing !== undefined) {
        payload.pairing = draftPairing;
      }
      const draftMinDays = dataToSave?.minDaysBetweenEnrollments ?? (draft as any).minDaysBetweenEnrollments;
      if (draftMinDays !== undefined) {
        payload.minDaysBetweenEnrollments = draftMinDays;
      }
      const draftGoalMode = dataToSave?.goalMode ?? (draft as any).goalMode;
      if (draftGoalMode !== undefined) {
        payload.goalMode = draftGoalMode;
      }

      const idempotencyKey = `save-draft-${campaign.campaignId}-v${draft.version}-${Date.now()}`;

      const res = await fetch(`/api/campaigns/${campaign.campaignId}/draft`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const resData = await res.json();

      if (res.status === 409) {
        // Optimistic Concurrency Conflict
        setConflict({
          expected: resData.error?.details?.expectedVersion ?? draft.version,
          current: resData.error?.details?.currentVersion ?? draft.version + 1,
        });
        setSaveStatus('unsaved');
        return false;
      }

      if (!res.ok) {
        const detailsMsg = Array.isArray(resData.error?.details)
          ? resData.error.details.map((d: any) => `${d.field}: ${d.message}`).join(', ')
          : '';
        throw new Error(detailsMsg ? `Failed to save draft (${detailsMsg})` : (resData.error?.message || 'Failed to save draft'));
      }

      setCampaign(resData.campaign);
      setDraft(resData.draft);
      setSaveStatus('saved');
      return true;
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save draft');
      setSaveStatus('unsaved');
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Run Draft Validation (POST /campaigns/:id/validate)
  const runValidation = async () => {
    if (!campaign) return;

    try {
      setValidating(true);
      setErrorMsg(null);

      // Save draft first if unsaved
      if (saveStatus === 'unsaved') {
        const saved = await saveDraft();
        if (!saved) return;
      }

      const res = await fetch(`/api/campaigns/${campaign.campaignId}/validate`, {
        method: 'POST',
      });

      const report: any = await res.json();
      if (!res.ok) {
        throw new Error(report?.error?.message || report?.message || 'Failed to execute validation');
      }
      setValidationReport(report);

      // Refresh campaign status
      if (report.valid) {
        setCampaign((prev) => (prev ? { ...prev, status: 'VALIDATED' } : prev));
      } else {
        setCampaign((prev) => (prev ? { ...prev, status: 'DRAFT' } : prev));
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to execute validation');
    } finally {
      setValidating(false);
    }
  };

  // Run Campaign Dry Run (POST /campaigns/:id/dry-runs)
  const runDryRun = async () => {
    if (!campaign) return;

    try {
      setRunningDryRun(true);
      setErrorMsg(null);

      // Save draft first if unsaved
      if (saveStatus === 'unsaved') {
        const saved = await saveDraft();
        if (!saved) return;
      }

      const res = await fetch(`/api/campaigns/${campaign.campaignId}/dry-runs`, {
        method: 'POST',
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.error?.details && typeof data.error.details === 'object' && 'errors' in data.error.details) {
          setValidationReport(data.error.details as CampaignValidationReport);
        }
        throw new Error(data.error?.message || 'Failed to execute campaign dry run');
      }

      setDryRun(data);
      if (data.recipientPlans && data.recipientPlans.length > 0) {
        setExpandedPlanIndex(0);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Error executing dry run simulation');
    } finally {
      setRunningDryRun(false);
    }
  };

  // Activate Campaign or Publish Revision (Spec p9, p20, p25)
  const handleActivateOrPublish = async () => {
    if (!campaign || !draft) return;

    try {
      setActivating(true);
      setActivationError(null);
      setErrorMsg(null);

      // Save draft first if unsaved
      if (saveStatus === 'unsaved') {
        const saved = await saveDraft();
        if (!saved) {
          setActivating(false);
          return;
        }
      }

      const isRevision = campaign.status === 'ACTIVE' || Boolean(activeVersion);
      const endpoint = isRevision
        ? `/api/campaigns/${campaign.campaignId}/publish-revision`
        : `/api/campaigns/${campaign.campaignId}/activate`;

      // Spec C15 idempotency: stable key per version so rapid double clicks yield the same operation
      const idempotencyKey = `activate-${campaign.campaignId}-v${draft.version}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(isRevision ? { expectedVersion: draft.version } : {}),
      });

      const resData = await res.json();

      if (!res.ok) {
        const errMessage = resData.error?.message || 'Failed to activate campaign';
        const detailsStr = Array.isArray(resData.error?.details)
          ? resData.error.details.map((d: any) => `${d.fieldPath || d.field}: ${d.message} (${d.resolutionOwner || ''})`).join(', ')
          : '';
        const fullErr = detailsStr ? `${errMessage}: ${detailsStr}` : errMessage;
        setActivationError(fullErr);
        setErrorMsg(fullErr);
        return;
      }

      setActivationSuccess({
        message: resData.message,
        nextEvaluationAt: resData.nextEvaluationAt,
      });

      setConfirmModalOpen(false);

      // Refresh data and switch to detail view
      await loadCampaignData();
      setViewMode('detail');
    } catch (err: any) {
      const msg = err.message || 'Network error during campaign activation';
      setActivationError(msg);
      setErrorMsg(msg);
    } finally {
      setActivating(false);
    }
  };

  // Step Operations
  const handleAddStep = () => {
    if (!draft || draft.steps.length >= 3) return;

    const isEventDelay = draft.trigger?.type === 'EVENT_DELAY';
    const lastStep = draft.steps[draft.steps.length - 1];

    let newStep: any;
    if (isEventDelay) {
      const lastDelay = (lastStep as any)?.delay?.value ?? (lastStep as any)?.delayValue ?? 1;
      newStep = {
        stepId: `welcome_step_${draft.steps.length + 1}`,
        stepName: `Welcome Step ${draft.steps.length + 1}`,
        delay: { unit: 'HOURS', value: lastDelay + 24 },
        outsideHoursPolicy: 'DEFER_NEXT_DAY',
        maxDeferralHours: 24,
        maxLatenessMinutes: 180,
        prerequisite: 'NONE',
        templateRef: null,
        bindings: {},
        stopOnReply: true,
        stopOnGoal: false,
      };
    } else {
      const nextOffset = lastStep ? (lastStep.offsetDays || 0) + 7 : 0;
      newStep = {
        stepId: `step_${draft.steps.length + 1}`,
        stepName: `Step ${draft.steps.length + 1}`,
        offsetDays: nextOffset,
        localTime: '10:00',
        prerequisite: draft.steps.length === 0 ? 'NONE' : 'PREVIOUS_ACCEPTED',
        templateRef: null,
        bindings: {},
        stopOnReply: true,
        stopOnGoal: true,
        maxLatenessMinutes: 120,
      };
    }

    const updatedSteps = [...draft.steps, newStep];
    setDraft({ ...draft, steps: updatedSteps });
    setSaveStatus('unsaved');
  };

  const handleRemoveStep = (index: number) => {
    if (!draft || draft.steps.length <= 1) return;
    const updatedSteps = draft.steps.filter((_, i) => i !== index);
    setDraft({ ...draft, steps: updatedSteps });
    setSaveStatus('unsaved');
  };

  const handleUpdateStep = (index: number, updates: Partial<CampaignStep>) => {
    if (!draft) return;
    const updatedSteps = draft.steps.map((st, i) => (i === index ? { ...st, ...updates } : st));
    setDraft({ ...draft, steps: updatedSteps });
    setSaveStatus('unsaved');
  };

  const handleSelectTemplate = (stepIndex: number, templateId: string) => {
    if (!draft) return;
    if (!templateId) {
      handleUpdateStep(stepIndex, {
        templateRef: null,
        bindings: {},
      });
      return;
    }

    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;

    const currentStep = draft.steps[stepIndex];
    let needsOffer = false;
    const initialBindings: Record<string, string> = {};
    (tpl.variables || []).forEach((v) => {
      const vName = (v.name || '').toLowerCase();
      if (vName.includes('offer') || vName.includes('amount') || vName.includes('discount')) {
        initialBindings[String(v.index)] = 'offer.amountRupees';
        needsOffer = true;
      } else if (vName.includes('shop') || vName.includes('store') || vName.includes('boutique') || v.index === 2) {
        initialBindings[String(v.index)] = 'shop.displayName';
      } else if (vName.includes('date')) {
        initialBindings[String(v.index)] = 'order.firstOrderDate';
      } else {
        initialBindings[String(v.index)] = 'customer.firstName';
      }
    });

    const stepUpdate: any = {
      templateRef: {
        id: tpl.id,
        revision: tpl.revision,
        language: tpl.language,
      },
      bindings: initialBindings,
    };

    if (needsOffer && !(currentStep as any)?.offerRef?.offerId) {
      stepUpdate.offerRef = {
        offerId: offers[0]?.offerId || 'off_welcome_50',
      };
    }

    handleUpdateStep(stepIndex, stepUpdate);
  };

  const handleUpdateBinding = (
    stepIndex: number,
    varIndex: number,
    source: string,
    literalValue?: string,
    fallbackLiteral?: string
  ) => {
    if (!draft) return;
    const currentStep = draft.steps[stepIndex];
    const key = String(varIndex);

    let bindingVal: any;
    if (source === 'literal') {
      bindingVal = { source: 'literal', value: literalValue ?? '' };
    } else if (source === 'customer.firstName') {
      bindingVal = {
        source: 'customer.firstName',
        ...(fallbackLiteral !== undefined && fallbackLiteral !== '' ? { fallbackLiteral } : {}),
      };
    } else {
      bindingVal = { source };
    }

    const updatedBindings = {
      ...currentStep.bindings,
      [key]: bindingVal,
    };

    handleUpdateStep(stepIndex, { bindings: updatedBindings });
  };

  const handleCheckSuggestionsDiff = async () => {
    if (!draft || templates.length === 0) return;
    try {
      const presetParam =
        draft.trigger?.type === 'CUSTOMER_EVENT_DATE'
          ? (draft.trigger?.occasionKind === 'GIFT' ? 'gift_reminder' : 'wedding_reminder')
          : draft.trigger?.anchor === 'FIRST_QUALIFYING_ORDER'
          ? 'FIRST_TO_SECOND_PURCHASE'
          : draft.trigger?.type === 'EVENT_DELAY'
          ? 'WELCOME_NEW_CUSTOMER'
          : 'BIRTHDAY';

      const res = await fetch(`/api/template-mapping-suggestions?presetId=${encodeURIComponent(presetParam)}`);
      const data = res.ok ? await res.json() : null;
      const suggestions = data?.data || {};

      const diffs: Array<{
        stepIndex: number;
        stepName: string;
        templateId: string;
        templateName: string;
        variableIndex: number;
        variableName: string;
        currentSource: string;
        currentLiteral?: string;
        currentFallback?: string;
        suggestedSource: string;
        suggestedLiteral?: string;
        suggestedFallback?: string;
      }> = [];
      const suggestedBindingsByStep: Record<number, Record<string, any>> = {};

      draft.steps.forEach((step, sIdx) => {
        const tplId = step.templateRef?.id;
        if (!tplId) return;

        const template = templates.find((t) => t.id === tplId);
        const suggestionItem = suggestions[tplId] || (template ? suggestions[template.name] : null);
        if (!suggestionItem) return;

        const suggestedBindings =
          suggestionItem.bindings ||
          suggestionItem.presets?.[presetParam]?.bindings ||
          suggestionItem.presets?.['*']?.bindings ||
          {};

        suggestedBindingsByStep[sIdx] = suggestedBindings;

        (template?.variables || []).forEach((v) => {
          const vKey = String(v.index);
          const curr = step.bindings?.[vKey];
          let currSrc = 'customer.firstName';
          let currLit = '';
          let currFb = '';
          if (typeof curr === 'string') {
            if (curr.startsWith('literal:')) {
              currSrc = 'literal';
              currLit = curr.replace('literal:', '');
            } else {
              currSrc = curr;
            }
          } else if (curr && typeof curr === 'object') {
            currSrc = curr.source || 'customer.firstName';
            currLit = curr.value || '';
            currFb = curr.fallbackLiteral || '';
          }

          const sugg = suggestedBindings[vKey];
          if (sugg) {
            const suggSrc = typeof sugg === 'string' ? (sugg.startsWith('literal:') ? 'literal' : sugg) : sugg.source;
            const suggLit = typeof sugg === 'string' && sugg.startsWith('literal:') ? sugg.replace('literal:', '') : sugg.value || '';
            const suggFb = typeof sugg === 'object' ? sugg.fallbackLiteral || '' : '';

            if (currSrc !== suggSrc || currLit !== suggLit || currFb !== suggFb) {
              diffs.push({
                stepIndex: sIdx,
                stepName: step.stepName || `Step ${sIdx + 1}`,
                templateId: tplId,
                templateName: template?.name || tplId,
                variableIndex: v.index,
                variableName: v.name || `Var ${v.index}`,
                currentSource: currSrc,
                currentLiteral: currLit,
                currentFallback: currFb,
                suggestedSource: suggSrc,
                suggestedLiteral: suggLit,
                suggestedFallback: suggFb,
              });
            }
          }
        });
      });

      if (diffs.length > 0) {
        setSuggestionDiffModal({
          open: true,
          diffs,
          suggestedBindingsByStep,
        });
      } else {
        setAutoFillNotice('All step parameter mappings already match recommended catalogue suggestions!');
        setTimeout(() => setAutoFillNotice(null), 4000);
      }
    } catch (err) {
      console.error('Failed to load suggestions:', err);
    }
  };

  const handleApplySuggestions = () => {
    if (!draft || !suggestionDiffModal) return;
    const updatedSteps = draft.steps.map((st, sIdx) => {
      const suggForStep = suggestionDiffModal.suggestedBindingsByStep[sIdx];
      if (!suggForStep) return st;
      return {
        ...st,
        bindings: {
          ...st.bindings,
          ...suggForStep,
        },
      };
    });
    setDraft({ ...draft, steps: updatedSteps });
    setSaveStatus('unsaved');
    setSuggestionDiffModal(null);
    setAutoFillNotice('Recommended variable mapping suggestions applied successfully!');
    setTimeout(() => setAutoFillNotice(null), 4000);
  };

  const handleAutoFillRecommendedTemplates = () => {
    if (!draft || templates.length === 0) return;

    let recommended: any[];
    if (
      draft.trigger?.type === 'ENQUIRY_EVENT_DELAY' ||
      (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION'
    ) {
      const tplItem =
        templates.find((t) => t.id === 'tpl_enquiry_followup_item') || templates[0];
      const tplSecond =
        templates.find((t) => t.id === 'tpl_enquiry_followup_second') || templates[1] || tplItem;
      const tplGeneral =
        templates.find((t) => t.id === 'tpl_enquiry_followup_general') || templates[2] || tplItem;
      recommended = [tplItem, tplSecond, tplGeneral];
    } else if (draft.trigger?.type === 'EVENT_DELAY') {
      const sendableTemplates = templates.filter((t) => t.sendable);
      const tplWelcome =
        sendableTemplates.find((t) => t.id === 'tpl_hello_world') ||
        templates.find((t) => t.id === 'tpl_welcome_new_customer') ||
        templates.find((t) => t.id === 'tpl_welcome_new_customer_offer') ||
        sendableTemplates[0] ||
        templates[0];
      recommended = [tplWelcome, tplWelcome, tplWelcome];
    } else if (draft.trigger?.type === 'INACTIVITY_THRESHOLD') {
      const tplWinback = templates.find((t) => t.id === 'tpl_winback_invite') || templates[0];
      recommended = [tplWinback, tplWinback, tplWinback];
    } else {
      const tplInvite = templates.find((t) => t.id === 'tpl_birthday_invite') || templates[0];
      const tplFollowup = templates.find((t) => t.id === 'tpl_birthday_followup') || templates[1] || tplInvite;
      const tplGreeting = templates.find((t) => t.id === 'tpl_hello_world') || templates[2] || tplInvite;
      recommended = [tplInvite, tplFollowup, tplGreeting];
    }

    const isEnquiry =
      draft.trigger?.type === 'ENQUIRY_EVENT_DELAY' ||
      (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION';

    const updatedSteps = draft.steps.map((st, i) => {
      const tpl = recommended[i] || recommended[0];
      const initialBindings: Record<string, any> = {};
      let needsOffer = false;
      (tpl.variables || []).forEach((v: any) => {
        const vName = (v.name || '').toLowerCase();
        if (vName.includes('item') || vName.includes('product')) {
          initialBindings[String(v.index)] = {
            source: 'item.name',
            fallbackLiteral: 'the item you asked about',
          };
        } else if (isEnquiry && vName.includes('date')) {
          initialBindings[String(v.index)] = { source: 'enquiry.localDate' };
        } else if (vName.includes('offer') || vName.includes('amount') || vName.includes('discount')) {
          initialBindings[String(v.index)] = { source: 'offer.amountRupees' };
          needsOffer = true;
        } else if (vName.includes('shop') || vName.includes('store') || vName.includes('boutique') || v.index === 2) {
          initialBindings[String(v.index)] = { source: 'shop.displayName' };
        } else if (vName.includes('date')) {
          initialBindings[String(v.index)] = { source: 'order.firstOrderDate' };
        } else {
          initialBindings[String(v.index)] = {
            source: 'customer.firstName',
            fallbackLiteral: 'Valued Customer',
          };
        }
      });

      const resStep: any = {
        ...st,
        templateRef: {
          id: tpl.id,
          revision: tpl.revision,
          language: tpl.language,
        },
        bindings: initialBindings,
      };

      if (needsOffer && !(st as any)?.offerRef?.offerId) {
        resStep.offerRef = {
          offerId: offers[0]?.offerId || 'off_welcome_50',
        };
      }

      return resStep;
    });

    setDraft({ ...draft, steps: updatedSteps });
    setSaveStatus('unsaved');
  };


  // Audience Rule Operations (Feature 6: Spec p10)
  const handleSetAudienceMode = (mode: 'ALL_ELIGIBLE' | 'CUSTOM_RULES') => {
    if (!draft) return;
    if (mode === 'ALL_ELIGIBLE') {
      setDraft({
        ...draft,
        audience: { mode: 'ALL_ELIGIBLE' },
      });
    } else {
      setDraft({
        ...draft,
        audience: {
          mode: 'CUSTOM_RULES',
          rules: draft.audience?.rules || {
            all: [{ field: 'tags', op: 'contains', value: 'VIP' }],
            any: [],
            none: [],
          },
        },
      });
    }
    setSaveStatus('unsaved');
  };

  const handleAddAudienceRule = (group: 'all' | 'any' | 'none') => {
    if (!draft) return;
    const currentRules = draft.audience?.rules || { all: [], any: [], none: [] };
    const currentGroup = currentRules[group] || [];
    const updatedGroup: AudienceRulePredicate[] = [
      ...currentGroup,
      { field: 'tags', op: 'contains', value: 'VIP' },
    ];
    setDraft({
      ...draft,
      audience: {
        mode: 'CUSTOM_RULES',
        rules: {
          ...currentRules,
          [group]: updatedGroup,
        },
      },
    });
    setSaveStatus('unsaved');
  };

  const handleUpdateAudienceRule = (
    group: 'all' | 'any' | 'none',
    index: number,
    updates: Partial<AudienceRulePredicate>
  ) => {
    if (!draft) return;
    const currentRules = draft.audience?.rules || { all: [], any: [], none: [] };
    const currentGroup = currentRules[group] || [];
    const updatedGroup = currentGroup.map((item, i) =>
      i === index ? { ...item, ...updates } : item
    );
    setDraft({
      ...draft,
      audience: {
        mode: 'CUSTOM_RULES',
        rules: {
          ...currentRules,
          [group]: updatedGroup,
        },
      },
    });
    setSaveStatus('unsaved');
  };

  const handleRemoveAudienceRule = (group: 'all' | 'any' | 'none', index: number) => {
    if (!draft) return;
    const currentRules = draft.audience?.rules || { all: [], any: [], none: [] };
    const currentGroup = currentRules[group] || [];
    const updatedGroup = currentGroup.filter((_, i) => i !== index);
    setDraft({
      ...draft,
      audience: {
        mode: 'CUSTOM_RULES',
        rules: {
          ...currentRules,
          [group]: updatedGroup,
        },
      },
    });
    setSaveStatus('unsaved');
  };

  const dummyTemplateInDraft = useMemo(() => {
    if (!draft || !templates.length) return null;
    return templates.find(
      (t) => !t.sendable && draft.steps?.some((s) => s.templateRef?.id === t.id)
    );
  }, [draft, templates]);

  if (loading) {
    return (
      <AppShell activeTab="campaigns">
        <div style={{ padding: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <Loader2 className="animate-spin" size={26} color="var(--accent-indigo)" />
          <span style={{ color: 'var(--text-secondary)' }}>Loading campaign draft editor...</span>
        </div>
      </AppShell>
    );
  }

  if (!campaign || !draft) {
    return (
      <AppShell activeTab="campaigns">
        <div className="glass-panel" style={{ padding: 40, textAlign: 'center' }}>
          <AlertCircle size={36} color="var(--accent-rose)" style={{ margin: '0 auto 16px' }} />
          <h3 style={{ fontSize: '1.25rem', color: '#fff', marginBottom: 8 }}>Campaign Not Found</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>
            {errorMsg || 'The requested campaign does not exist or has been removed.'}
          </p>
          <button onClick={() => router.push('/campaigns')} className="btn btn-secondary">
            <ArrowLeft size={16} />
            Return to Campaigns
          </button>
        </div>
      </AppShell>
    );
  }

  const isRevision = campaign.status === 'ACTIVE' || Boolean(activeVersion);

  return (
    <AppShell activeTab="campaigns">
      {viewMode === 'detail' && activeVersion ? (
        <CampaignDetailView
          campaign={campaign}
          activeVersion={activeVersion}
          draft={draft}
          versions={versions}
          onEditCampaign={() => setViewMode('wizard')}
          onBackToCampaigns={() => router.push('/campaigns')}
          onCampaignUpdated={loadCampaignData}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1040, margin: '0 auto', width: '100%' }}>
          {/* Top Header & Save Actions */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button
                onClick={() => router.push('/campaigns')}
                className="btn btn-secondary"
                style={{ padding: '8px 12px', fontSize: '0.85rem' }}
              >
                <ArrowLeft size={16} />
                Campaigns
              </button>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', margin: 0 }}>
                    {draft.name}
                  </h2>
                  <span className={`badge ${campaign.status === 'VALIDATED' ? 'badge-indigo' : campaign.status === 'ACTIVE' ? 'badge-emerald' : 'badge-amber'}`}>
                    {campaign.status}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.75rem',
                      color: 'var(--accent-cyan)',
                      background: 'rgba(6, 182, 212, 0.1)',
                      padding: '2px 8px',
                      borderRadius: 6,
                    }}
                  >
                    v{draft.version}
                  </span>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {campaign.campaignId} &bull; Preset: {campaign.presetId}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {activeVersion && (
                <button
                  type="button"
                  onClick={() => setViewMode('detail')}
                  className="btn btn-secondary"
                  style={{ padding: '8px 14px', fontSize: '0.85rem' }}
                >
                  <Layers size={15} />
                  Active Snapshot
                </button>
              )}

              <span
                style={{
                  fontSize: '0.8rem',
                  color: saveStatus === 'saved' ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {saveStatus === 'saved' ? (
                  <>
                    <Check size={14} /> Saved
                  </>
                ) : saveStatus === 'saving' ? (
                  <>
                    <Loader2 className="animate-spin" size={14} /> Saving...
                  </>
                ) : (
                  'Unsaved changes'
                )}
              </span>

              <button
                onClick={() => saveDraft()}
                disabled={saving}
                className="btn btn-secondary"
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                <Save size={15} />
                Save Draft
              </button>

              <button
                onClick={runValidation}
                disabled={validating}
                className="btn btn-primary"
                style={{ padding: '8px 18px', fontSize: '0.85rem' }}
              >
                {validating ? (
                  <>
                    <Loader2 className="animate-spin" size={15} /> Validating...
                  </>
                ) : (
                  <>
                    <Sparkles size={15} /> Validate
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Activation Success Alert */}
          {activationSuccess && (
            <div
              className="glass-panel"
              style={{
                padding: '16px 20px',
                background: 'rgba(16, 185, 129, 0.12)',
                borderColor: 'rgba(16, 185, 129, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <CheckCircle2 size={24} color="var(--accent-emerald)" style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.95rem' }}>
                    {activationSuccess.message}
                  </div>
                  {activationSuccess.nextEvaluationAt && (
                    <div style={{ fontSize: '0.8rem', color: '#a7f3d0' }}>
                      Next evaluation scheduled for: {new Date(activationSuccess.nextEvaluationAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => setActivationSuccess(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '1.25rem',
                }}
              >
                &times;
              </button>
            </div>
          )}

        {/* 409 Optimistic Concurrency Conflict Modal / Banner (Spec p26, C16) */}
        {conflict && (
          <div
            className="glass-panel"
            style={{
              padding: '16px 20px',
              background: 'rgba(239, 68, 68, 0.12)',
              borderColor: 'rgba(239, 68, 68, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <AlertTriangle size={24} color="var(--accent-rose)" style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.9rem' }}>
                  Version Conflict (HTTP 409)
                </div>
                <div style={{ fontSize: '0.8rem', color: '#fecdd3' }}>
                  Draft was updated in another window (Expected v{conflict.expected}, current is v{conflict.current}).
                  Reload the latest draft to avoid overwriting changes.
                </div>
              </div>
            </div>
            <button
              onClick={loadCampaignData}
              className="btn btn-secondary"
              style={{ fontSize: '0.8rem', padding: '6px 14px', flexShrink: 0 }}
            >
              <RotateCcw size={14} />
              Reload Latest Draft
            </button>
          </div>
        )}

        {/* Top-Level Error Alert Banner */}
        {errorMsg && (
          <div
            className="glass-panel"
            style={{
              padding: '14px 18px',
              background: 'rgba(239, 68, 68, 0.12)',
              borderColor: 'rgba(239, 68, 68, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <AlertCircle size={22} color="var(--accent-rose)" style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.9rem' }}>
                  Attention Required
                </div>
                <div style={{ fontSize: '0.825rem', color: '#fecdd3' }}>
                  {errorMsg}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {errorMsg.toLowerCase().includes('template') && (
                <button
                  type="button"
                  onClick={() => setActiveStep(3)}
                  className="btn btn-secondary"
                  style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                >
                  Go to Step 3: Messages &rarr;
                </button>
              )}
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '1.25rem',
                  padding: '2px 6px',
                  lineHeight: 1,
                }}
              >
                &times;
              </button>
            </div>
          </div>
        )}

        {/* Wizard Navigation Tabs */}
        <div
          className="glass-panel"
          style={{
            padding: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            overflowX: 'auto',
          }}
        >
          {WIZARD_STEPS.map((step) => {
            const isActive = activeStep === step.id;
            const isCompleted = activeStep > step.id;

            return (
              <button
                key={step.id}
                onClick={() => setActiveStep(step.id)}
                style={{
                  flex: 1,
                  minWidth: 140,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '10px 14px',
                  borderRadius: 10,
                  background: isActive ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                  border: isActive ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid transparent',
                  color: isActive ? '#fff' : isCompleted ? 'var(--text-secondary)' : 'var(--text-muted)',
                  fontWeight: isActive ? 700 : 500,
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: isActive
                      ? 'var(--accent-indigo)'
                      : isCompleted
                      ? 'rgba(16, 185, 129, 0.2)'
                      : 'rgba(255, 255, 255, 0.1)',
                    color: isActive ? '#fff' : isCompleted ? 'var(--accent-emerald)' : 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                  }}
                >
                  {isCompleted ? <Check size={13} /> : step.id}
                </span>
                {step.label}
              </button>
            );
          })}
        </div>

        {/* Wizard Step Content */}
        <div className="glass-panel" style={{ padding: 32 }}>
          {/* STEP 1: TRIGGER */}
          {activeStep === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                  Step 1: Campaign Trigger & Scope
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  Define the recurring annual customer date trigger, store timezone, and enabled branches.
                </p>
              </div>

              {/* Campaign Name */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                  Campaign Name
                </label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => {
                    setDraft({ ...draft, name: e.target.value });
                    setSaveStatus('unsaved');
                  }}
                  minLength={3}
                  maxLength={100}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid var(--border-color)',
                    color: '#fff',
                    fontSize: '0.9rem',
                  }}
                />
              </div>

              {/* Trigger Type & Threshold / Occasion Field */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                    Trigger Family
                  </label>
                  <input
                    type="text"
                    disabled
                    value={
                      draft.trigger.type === 'ORDER_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ORDER_COMPLETED_AT'
                        ? 'ORDER_EVENT_DELAY (Outfit Completion Delay)'
                        : draft.trigger.type === 'ENQUIRY_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION'
                        ? 'ENQUIRY_EVENT_DELAY (Unresolved Customer Enquiry Follow-Up)'
                        : draft.trigger.type === 'INACTIVITY_THRESHOLD'
                        ? 'INACTIVITY_THRESHOLD (Inactivity Threshold Scan)'
                        : draft.trigger.type === 'EVENT_DELAY'
                        ? draft.trigger.anchor === 'FIRST_QUALIFYING_ORDER'
                          ? 'EVENT_DELAY (First Qualifying Order Delay)'
                          : 'EVENT_DELAY (First Qualifying Purchase Delay)'
                        : draft.trigger.type === 'CUSTOMER_EVENT_DATE'
                        ? `CUSTOMER_EVENT_DATE (${draft.trigger.occasionKind || 'Occasion'} Date Reminder)`
                        : 'ANNUAL_DATE (Annual Customer Occasion)'
                    }
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-muted)',
                      fontSize: '0.875rem',
                    }}
                  />
                </div>

                {draft.trigger.type === 'ENQUIRY_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION' ? (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Trigger Description
                        </label>
                        <div
                          style={{
                            padding: '10px 14px',
                            borderRadius: 8,
                            background: 'rgba(255, 255, 255, 0.03)',
                            border: '1px solid var(--border-color)',
                            color: 'var(--text-secondary)',
                            fontSize: '0.875rem',
                          }}
                        >
                          Follow up before customer interest is lost
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Both nudges are measured from the customer&apos;s authoritative last interaction moment (the same anchor for all steps).
                        </span>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Useful Window (Days from enquiry createdAt)
                        </label>
                        <input
                          id="input-useful-for-days"
                          type="number"
                          min={1}
                          max={60}
                          value={(draft as any).usefulForDays ?? 14}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10) || 14;
                            setDraft({
                              ...draft,
                              usefulForDays: Math.min(60, Math.max(1, val)),
                            } as any);
                            setSaveStatus('unsaved');
                          }}
                          style={{
                            width: '100%',
                            padding: '10px 14px',
                            borderRadius: 8,
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid var(--border-color)',
                            color: '#fff',
                            fontSize: '0.9rem',
                          }}
                        />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Steps scheduled past this deadline will be skipped with ENQUIRY_TOO_OLD (1–60 days, default 14).
                        </span>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Campaign Goal &amp; Halt Mode
                        </label>
                        <select
                          id="select-goal-mode"
                          value={(draft as any).goalMode || 'ITEM_OR_TAGGED'}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              goalMode: e.target.value as any,
                            } as any);
                            setSaveStatus('unsaved');
                          }}
                          style={{
                            width: '100%',
                            padding: '10px 14px',
                            borderRadius: 8,
                            backgroundColor: '#111827',
                            border: '1px solid var(--border-color)',
                            color: '#fff',
                            fontSize: '0.875rem',
                            colorScheme: 'dark',
                          }}
                        >
                          <option value="ITEM_OR_TAGGED">ITEM_OR_TAGGED (Order tagged enquiry:id OR enquired item purchase - Recommended)</option>
                          <option value="TAGGED_ONLY">TAGGED_ONLY (Explicit enquiry tag or manual staff mark-goal only)</option>
                          <option value="ANY_QUALIFYING_ORDER">ANY_QUALIFYING_ORDER (Any qualifying completed purchase halts campaign)</option>
                        </select>
                        {(draft as any).goalMode === 'ANY_QUALIFYING_ORDER' && (
                          <div
                            style={{
                              marginTop: 6,
                              padding: '6px 10px',
                              borderRadius: 6,
                              background: 'rgba(245, 158, 11, 0.12)',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                              color: 'var(--accent-amber)',
                              fontSize: '0.75rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <AlertTriangle size={13} />
                            <span>Warning: May stop follow-ups on unrelated customer purchases (Spec p11).</span>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
                        <input
                          id="checkbox-require-item"
                          type="checkbox"
                          checked={!!(draft as any).requireItem}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              requireItem: e.target.checked,
                            } as any);
                            setSaveStatus('unsaved');
                          }}
                          style={{ width: 18, height: 18, cursor: 'pointer' }}
                        />
                        <label htmlFor="checkbox-require-item" style={{ fontSize: '0.85rem', color: '#fff', cursor: 'pointer' }}>
                          Require Item Reference (skip enquiries that do not specify a product/variant)
                        </label>
                      </div>
                    </div>

                    {/* 3 Core Enquiry Informational Notices */}
                    <div
                      style={{
                        padding: '14px 18px',
                        borderRadius: 8,
                        background: 'rgba(99, 102, 241, 0.08)',
                        border: '1px solid rgba(99, 102, 241, 0.25)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: '0.85rem', color: '#c7d2fe' }}>
                        <Info size={16} color="var(--accent-indigo)" />
                        <span>Unresolved Enquiry Platform Principles</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, fontSize: '0.8rem', color: '#e0e7ff' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: 'var(--accent-indigo)', fontWeight: 700 }}>1.</span>
                          <span>Enquiries come from another system; a staff edit is not customer activity.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: 'var(--accent-indigo)', fontWeight: 700 }}>2.</span>
                          <span>A follow-up never reserves an item.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: 'var(--accent-indigo)', fontWeight: 700 }}>3.</span>
                          <span>If the enquired item is unavailable that step is skipped.</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : draft.trigger.type === 'EVENT_DELAY' ? (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Trigger Description
                        </label>
                        <div
                          style={{
                            padding: '10px 14px',
                            borderRadius: 8,
                            background: 'rgba(255, 255, 255, 0.03)',
                            border: '1px solid var(--border-color)',
                            color: 'var(--text-secondary)',
                            fontSize: '0.875rem',
                          }}
                        >
                          Sent after a customer&apos;s first paid purchase
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Earliest qualifying completed bill (paid, net &gt; 0, identity captured). Halts if repeat purchase occurs.
                        </span>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Campaign Enrollment Scope
                        </label>
                        <select
                          id="select-campaign-scope"
                          value={(draft as any).scope || 'PER_CUSTOMER'}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              scope: e.target.value as any,
                            } as any);
                            setSaveStatus('unsaved');
                          }}
                          style={{
                            width: '100%',
                            padding: '10px 14px',
                            borderRadius: 8,
                            backgroundColor: '#111827',
                            border: '1px solid var(--border-color)',
                            color: '#fff',
                            fontSize: '0.875rem',
                            colorScheme: 'dark',
                          }}
                        >
                          <option value="PER_CUSTOMER">PER_CUSTOMER (Strictly ONCE per customer lifetime across all branches)</option>
                          <option value="PER_CUSTOMER_PER_BRANCH">PER_CUSTOMER_PER_BRANCH (Once per boutique branch)</option>
                        </select>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Default: strictly ONCE per customer lifecycle. Five items on one bill = one welcome. Five bills on the same day = one welcome.
                        </span>
                      </div>
                    </div>

                    {/* Minimum First Order Net Paise */}
                    <div style={{ maxWidth: 360 }}>
                      <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                        Minimum First Order Amount (₹)
                      </label>
                      <input
                        id="input-min-first-order"
                        type="number"
                        min={0}
                        step={10}
                        placeholder="0 (No minimum)"
                        value={((draft as any).minFirstOrderNetPaise || 0) / 100}
                        onChange={(e) => {
                          const inr = parseFloat(e.target.value) || 0;
                          setDraft({
                            ...draft,
                            minFirstOrderNetPaise: Math.max(0, Math.round(inr * 100)),
                          } as any);
                          setSaveStatus('unsaved');
                        }}
                        style={{
                          width: '100%',
                          padding: '10px 14px',
                          borderRadius: 8,
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid var(--border-color)',
                          color: '#fff',
                          fontSize: '0.9rem',
                        }}
                      />
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                        {((draft as any).minFirstOrderNetPaise || 0) > 0
                          ? `Enforces minimum net bill of ₹${((draft as any).minFirstOrderNetPaise / 100).toLocaleString('en-IN')} (${(draft as any).minFirstOrderNetPaise} paise). Lower bills are ignored without failing.`
                          : 'Optional minimum net bill amount required for welcome enrollment (₹0 = any completed order with netPaise > 0).'}
                      </span>
                    </div>

                    {/* 4 Required Informational Notices */}
                    <div
                      style={{
                        padding: '14px 18px',
                        borderRadius: 8,
                        background: 'rgba(99, 102, 241, 0.08)',
                        border: '1px solid rgba(99, 102, 241, 0.25)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: '0.85rem', color: '#c7d2fe' }}>
                        <Info size={16} color="var(--accent-indigo)" />
                        <span>Welcome Campaign Core Principles</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, fontSize: '0.8rem', color: '#e0e7ff' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: 'var(--accent-indigo)', fontWeight: 700 }}>1.</span>
                          <span>Welcome is sent only when the campaign is active and every gate passes.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: 'var(--accent-indigo)', fontWeight: 700 }}>2.</span>
                          <span>Orders and customers come from other systems.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: 'var(--accent-indigo)', fontWeight: 700 }}>3.</span>
                          <span>Welcome never includes order details.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: 'var(--accent-indigo)', fontWeight: 700 }}>4.</span>
                          <span>A number that is not on WhatsApp is only detected after a failed send; it is never resent.</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : draft.trigger.type === 'ORDER_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ORDER_COMPLETED_AT' ? (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Trigger Description
                        </label>
                        <div
                          style={{
                            padding: '10px 14px',
                            borderRadius: 8,
                            background: 'rgba(255, 255, 255, 0.03)',
                            border: '1px solid var(--border-color)',
                            color: 'var(--text-secondary)',
                            fontSize: '0.875rem',
                          }}
                        >
                          Qualifying Anchor Purchase + Delay (+5 Days Default)
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Evaluated when a customer purchases an anchor item (e.g. saree). Complements (blouse, petticoat, dupatta, accessories) are suggested after the configured delay.
                        </span>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Colour Match Mode
                        </label>
                        <select
                          id="select-outfit-colour-match"
                          value={(draft as any).pairing?.colourMatch || 'NEUTRAL_OR_SAME'}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              pairing: {
                                ...((draft as any).pairing || {}),
                                colourMatch: e.target.value,
                              },
                            } as any);
                            setSaveStatus('unsaved');
                          }}
                          style={{
                            width: '100%',
                            padding: '10px 14px',
                            borderRadius: 8,
                            backgroundColor: '#111827',
                            border: '1px solid var(--border-color)',
                            color: '#fff',
                            fontSize: '0.85rem',
                            colorScheme: 'dark',
                          }}
                        >
                          <option value="NEUTRAL_OR_SAME">NEUTRAL_OR_SAME (Same family scored +2, neutral colour scored +1)</option>
                          <option value="SAME_FAMILY">SAME_FAMILY (Strictly same colour family only)</option>
                          <option value="ANY">ANY (Any colour family allowed)</option>
                        </select>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Deterministic colour family matching rule (Hard Rule #2 &amp; #3: never infer personal traits).
                        </span>
                      </div>
                    </div>

                    {/* Weave, Lookback and Spacing Controls */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20 }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Already-Owned Lookback Window (Days)
                        </label>
                        <input
                          id="input-outfit-lookback-days"
                          type="number"
                          min={0}
                          value={(draft as any).pairing?.alreadyOwnedLookbackDays ?? 180}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              pairing: {
                                ...((draft as any).pairing || {}),
                                alreadyOwnedLookbackDays: parseInt(e.target.value, 10) || 0,
                              },
                            } as any);
                            setSaveStatus('unsaved');
                          }}
                          className="input-field"
                          style={{ width: '100%', fontSize: '0.85rem' }}
                        />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Prevents suggesting categories customer already purchased within lookback window (default 180 days).
                        </span>
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                          Minimum Spacing Between Enrollments (Days)
                        </label>
                        <input
                          id="input-outfit-spacing-days"
                          type="number"
                          min={1}
                          value={(draft as any).minDaysBetweenEnrollments ?? 30}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              minDaysBetweenEnrollments: parseInt(e.target.value, 10) || 30,
                            } as any);
                            setSaveStatus('unsaved');
                          }}
                          className="input-field"
                          style={{ width: '100%', fontSize: '0.85rem' }}
                        />
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          Minimum days between outfit campaign enrollments for the same customer (default 30 days).
                        </span>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, marginTop: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <input
                            id="checkbox-outfit-same-weave"
                            type="checkbox"
                            checked={Boolean((draft as any).pairing?.requireSameWeave)}
                            onChange={(e) => {
                              setDraft({
                                ...draft,
                                pairing: {
                                  ...((draft as any).pairing || {}),
                                  requireSameWeave: e.target.checked,
                                },
                              } as any);
                              setSaveStatus('unsaved');
                            }}
                            style={{ width: 16, height: 16, accentColor: 'var(--accent-indigo)', cursor: 'pointer' }}
                          />
                          <label htmlFor="checkbox-outfit-same-weave" style={{ fontSize: '0.85rem', color: '#fff', cursor: 'pointer' }}>
                            Prefer Same Weave (+1 priority score)
                          </label>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <input
                            id="checkbox-outfit-suppress-in-order"
                            type="checkbox"
                            checked={(draft as any).pairing?.suppressIfCategoryInOrder ?? true}
                            onChange={(e) => {
                              setDraft({
                                ...draft,
                                pairing: {
                                  ...((draft as any).pairing || {}),
                                  suppressIfCategoryInOrder: e.target.checked,
                                },
                              } as any);
                              setSaveStatus('unsaved');
                            }}
                            style={{ width: 16, height: 16, accentColor: 'var(--accent-indigo)', cursor: 'pointer' }}
                          />
                          <label htmlFor="checkbox-outfit-suppress-in-order" style={{ fontSize: '0.85rem', color: '#fff', cursor: 'pointer' }}>
                            Suppress if category already in anchor order
                          </label>
                        </div>
                      </div>
                    </div>

                    {/* 4 Mandatory Informational Notices (Spec requirement) */}
                    <div
                      style={{
                        padding: '14px 18px',
                        borderRadius: 8,
                        background: 'rgba(139, 92, 246, 0.08)',
                        border: '1px solid rgba(139, 92, 246, 0.25)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: '0.85rem', color: '#ddd6fe' }}>
                        <Sparkles size={16} color="var(--accent-purple, #a855f7)" />
                        <span>Complete the Outfit Core Principles (Spec p19, p28)</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, fontSize: '0.8rem', color: '#f3e8ff' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: '#c084fc', fontWeight: 700 }}>1.</span>
                          <span>Orders and products come from other systems.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: '#c084fc', fontWeight: 700 }}>2.</span>
                          <span>Suggestions come from product records only; customer names or personal traits are never used.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: '#c084fc', fontWeight: 700 }}>3.</span>
                          <span>A suggestion never reserves an item; only items in stock when the message is sent are chosen.</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ color: '#c084fc', fontWeight: 700 }}>4.</span>
                          <span>If not enough matching items are in stock, the step is skipped.</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : draft.trigger.type === 'CUSTOMER_EVENT_DATE' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                        Occasion Kind
                      </label>
                      <select
                        id="select-occasion-kind"
                        value={draft.trigger.occasionKind || 'WEDDING'}
                        onChange={(e) => {
                          const kind = e.target.value as 'GIFT' | 'WEDDING';
                          const defaultLead = kind === 'GIFT' ? 2 : 21;
                          setDraft({
                            ...draft,
                            priority: kind === 'WEDDING' ? 70 : 65,
                            trigger: {
                              ...draft.trigger,
                              occasionKind: kind,
                              fulfillmentLeadDays: defaultLead,
                            },
                          });
                          setSaveStatus('unsaved');
                        }}
                        style={{
                          width: '100%',
                          padding: '10px 14px',
                          borderRadius: 8,
                          backgroundColor: '#111827',
                          border: '1px solid var(--border-color)',
                          color: '#fff',
                          fontSize: '0.875rem',
                          colorScheme: 'dark',
                        }}
                      >
                        <option value="WEDDING">WEDDING — Wedding &amp; Consultation Reminder (Lead time 21d, Priority 70)</option>
                        <option value="GIFT">GIFT — Gift Occasion Reminder (Lead time 2d, Priority 65)</option>
                      </select>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                        Select the occasion type to target from registered CRM customer events.
                      </span>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                        Fulfillment Lead Time (Days)
                      </label>
                      <input
                        id="input-fulfillment-lead-days"
                        type="number"
                        min={0}
                        max={180}
                        value={draft.trigger.fulfillmentLeadDays ?? (draft.trigger.occasionKind === 'GIFT' ? 2 : 21)}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          setDraft({
                            ...draft,
                            trigger: {
                              ...draft.trigger,
                              fulfillmentLeadDays: isNaN(val) ? 0 : val,
                            },
                          });
                          setSaveStatus('unsaved');
                        }}
                        style={{
                          width: '100%',
                          padding: '10px 14px',
                          borderRadius: 8,
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid var(--border-color)',
                          color: '#fff',
                          fontSize: '0.9rem',
                        }}
                      />
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                        Minimum days required before event to fulfill order. Steps scheduled past this deadline will be safely skipped.
                      </span>
                    </div>

                    {draft.trigger.occasionKind === 'WEDDING' && (
                      <div
                        style={{
                          gridColumn: '1 / -1',
                          padding: '12px 16px',
                          borderRadius: 8,
                          background: 'rgba(99, 102, 241, 0.1)',
                          border: '1px solid rgba(99, 102, 241, 0.25)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          fontSize: '0.8rem',
                          color: '#c7d2fe',
                        }}
                      >
                        <Info size={18} color="var(--accent-indigo)" style={{ flexShrink: 0 }} />
                        <div>
                          <strong>Wedding Reminder Requirements:</strong> Store booking link (<code>bookingLinkUrl</code>) must be configured in Campaign Settings if booking steps are used. Templates must never claim an appointment is pre-booked or confirmed.
                        </div>
                      </div>
                    )}
                  </div>
                ) : draft.trigger.type === 'INACTIVITY_THRESHOLD' ? (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                      Inactivity Threshold (Days)
                    </label>
                    <input
                      id="input-inactivity-threshold"
                      type="number"
                      min={1}
                      max={730}
                      value={draft.trigger.thresholdDays || 90}
                      onChange={(e) => {
                        setDraft({
                          ...draft,
                          trigger: {
                            ...draft.trigger,
                            thresholdDays: parseInt(e.target.value, 10) || 90,
                          },
                        });
                        setSaveStatus('unsaved');
                      }}
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        borderRadius: 8,
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        color: '#fff',
                        fontSize: '0.9rem',
                      }}
                    />
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                      Configurable customer inactivity threshold (e.g. 90 or 180 days, Spec p14, p17).
                    </span>
                  </div>
                ) : (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                      Customer Occasion Field
                    </label>
                    <select
                      value={draft.trigger.field}
                      onChange={(e) => {
                        setDraft({
                          ...draft,
                          trigger: { ...draft.trigger, field: e.target.value },
                        });
                        setSaveStatus('unsaved');
                      }}
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        borderRadius: 8,
                        backgroundColor: '#111827',
                        border: '1px solid var(--border-color)',
                        color: '#fff',
                        fontSize: '0.875rem',
                        colorScheme: 'dark',
                      }}
                    >
                      <option value="customer.birthday" style={{ backgroundColor: '#111827', color: '#fff' }}>
                        customer.birthday (Customer Birthday)
                      </option>
                      <option value="customer.event" style={{ backgroundColor: '#111827', color: '#fff' }}>
                        customer.event (Customer Anniversary / Saved Event)
                      </option>
                    </select>
                  </div>
                )}
              </div>

              {/* Inactivity Category Filter / Leap-Day Policy & Timezone */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                {draft.trigger.type === 'INACTIVITY_THRESHOLD' ? (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                      Category Inactivity Filter (Optional)
                    </label>
                    <input
                      id="input-inactivity-category"
                      type="text"
                      placeholder="e.g. all, handloom, saree, silk"
                      value={draft.trigger.category || ''}
                      onChange={(e) => {
                        setDraft({
                          ...draft,
                          trigger: {
                            ...draft.trigger,
                            category: e.target.value ? e.target.value.trim() : undefined,
                          },
                        });
                        setSaveStatus('unsaved');
                      }}
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        borderRadius: 8,
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        color: '#fff',
                        fontSize: '0.9rem',
                      }}
                    />
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                      Per-category threshold when order category data exists (Spec p14, p17).
                    </span>
                  </div>
                ) : (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                      Leap-Day Policy (Feb 29 Rule)
                    </label>
                    <select
                      value={draft.trigger.leapDayPolicy}
                      onChange={(e) => {
                        setDraft({
                          ...draft,
                          trigger: {
                            ...draft.trigger,
                            leapDayPolicy: e.target.value as any,
                          },
                        });
                        setSaveStatus('unsaved');
                      }}
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        borderRadius: 8,
                        backgroundColor: '#111827',
                        border: '1px solid var(--border-color)',
                        color: '#fff',
                        fontSize: '0.875rem',
                        colorScheme: 'dark',
                      }}
                    >
                      <option value="FEB_28" style={{ backgroundColor: '#111827', color: '#fff' }}>
                        FEB_28 - Send on Feb 28 in non-leap years (Recommended)
                      </option>
                      <option value="MAR_01" style={{ backgroundColor: '#111827', color: '#fff' }}>
                        MAR_01 - Send on March 1 in non-leap years
                      </option>
                      <option value="LEAP_ONLY" style={{ backgroundColor: '#111827', color: '#fff' }}>
                        LEAP_ONLY - Send only during leap years
                      </option>
                    </select>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                      Spec p7: Explicit selection for recurring Feb 29 occasions.
                    </span>
                  </div>
                )}

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                    Timezone (IANA Zone)
                  </label>
                  <input
                    type="text"
                    value={draft.timezone}
                    onChange={(e) => {
                      setDraft({ ...draft, timezone: e.target.value });
                      setSaveStatus('unsaved');
                    }}
                    placeholder="Asia/Kolkata"
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#fff',
                      fontSize: '0.9rem',
                    }}
                  />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                    Inherited from boutique campaign settings.
                  </span>
                </div>
              </div>

              {/* Win-back Stop Rules Notice (Spec p14, A13, B17) */}
              {draft.trigger.type === 'INACTIVITY_THRESHOLD' && (
                <div
                  className="glass-panel"
                  style={{
                    padding: '12px 18px',
                    borderRadius: 8,
                    background: 'rgba(99, 102, 241, 0.08)',
                    border: '1px solid rgba(99, 102, 241, 0.25)',
                    fontSize: '0.825rem',
                    color: '#c7d2fe',
                    lineHeight: 1.5,
                  }}
                >
                  <strong style={{ color: '#fff' }}>Lifecycle &amp; Stop Rules (Spec p14, QA Matrix A13, B17):</strong> Occurrence is anchored on the last qualifying purchase (<code>winback:lastQualifyingOrderId:ruleId</code>) and enrolled ONCE. A new purchase cancels old steps and resets the anchor (A13). A refund restores the previous anchor without re-enrolling completed occurrences (B17). Customer replies hold sales sequences conservatively (A11).
                </div>
              )}

              {/* Branch Selection Scope */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 10 }}>
                  Store Branch Scope (Auth Scoped)
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {branches.map((b) => {
                    const isChecked = (draft.enabledBranches || []).includes(b.branchId);
                    return (
                      <label
                        key={b.branchId}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 14px',
                          borderRadius: 8,
                          background: isChecked ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                          border: isChecked ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid var(--border-color)',
                          cursor: 'pointer',
                          fontSize: '0.875rem',
                          color: isChecked ? '#fff' : 'var(--text-secondary)',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            let updated: string[];
                            if (e.target.checked) {
                              updated = [...(draft.enabledBranches || []), b.branchId];
                            } else {
                              updated = (draft.enabledBranches || []).filter((id) => id !== b.branchId);
                            }
                            setDraft({ ...draft, enabledBranches: updated });
                            setSaveStatus('unsaved');
                          }}
                        />
                        {b.name} ({b.branchId})
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: AUDIENCE */}
          {activeStep === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                  Step 2: Customer Audience & Mandatory Gates
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  Audience selection is autonomous. All enrolled customers must pass strict platform pre-send gates.
                </p>
              </div>

              {/* Audience Mode Toggle */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
                <div
                  onClick={() => handleSetAudienceMode('ALL_ELIGIBLE')}
                  className="glass-panel"
                  style={{
                    padding: 20,
                    cursor: 'pointer',
                    background:
                      draft.audience?.mode === 'ALL_ELIGIBLE'
                        ? 'rgba(99, 102, 241, 0.15)'
                        : 'rgba(255, 255, 255, 0.02)',
                    border:
                      draft.audience?.mode === 'ALL_ELIGIBLE'
                        ? '1px solid rgba(99, 102, 241, 0.5)'
                        : '1px solid var(--border-color)',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#fff' }}>
                      <Users size={18} color="var(--accent-indigo)" />
                      ALL_ELIGIBLE
                    </div>
                    {draft.audience?.mode === 'ALL_ELIGIBLE' && (
                      <span className="badge badge-indigo">Active</span>
                    )}
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Include all active customers who match the occasion trigger and pass mandatory platform gates.
                  </p>
                </div>

                <div
                  onClick={() => handleSetAudienceMode('CUSTOM_RULES')}
                  className="glass-panel"
                  style={{
                    padding: 20,
                    cursor: 'pointer',
                    background:
                      draft.audience?.mode === 'CUSTOM_RULES'
                        ? 'rgba(99, 102, 241, 0.15)'
                        : 'rgba(255, 255, 255, 0.02)',
                    border:
                      draft.audience?.mode === 'CUSTOM_RULES'
                        ? '1px solid rgba(99, 102, 241, 0.5)'
                        : '1px solid var(--border-color)',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#fff' }}>
                      <Filter size={18} color="var(--accent-cyan)" />
                      CUSTOM_RULES
                    </div>
                    {draft.audience?.mode === 'CUSTOM_RULES' && (
                      <span className="badge badge-indigo">Active</span>
                    )}
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Define allowlisted predicate rules (all, any, none) on tags, preferred category, city, spend, etc.
                  </p>
                </div>
              </div>

              {/* Custom Rules Editor (Spec p10) */}
              {draft.audience?.mode === 'CUSTOM_RULES' && (
                <div className="glass-panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                        Custom Audience Rule Conditions
                      </h4>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        All conditions use allowlisted fields and operators. Missing fields fail comparisons per spec p10.
                      </p>
                    </div>
                  </div>

                  {(['all', 'any', 'none'] as const).map((groupKey) => {
                    const groupRules = draft.audience?.rules?.[groupKey] || [];
                    const groupTitle =
                      groupKey === 'all'
                        ? 'Must Match ALL Conditions (AND)'
                        : groupKey === 'any'
                        ? 'Must Match AT LEAST ONE Condition (OR)'
                        : 'Must Match NONE of These Conditions (NOT / Exclusions)';
                    const groupDesc =
                      groupKey === 'all'
                        ? 'Customer is eligible only if all conditions below evaluate to true.'
                        : groupKey === 'any'
                        ? 'Neutral if empty. If conditions exist, customer must match at least one.'
                        : 'Neutral if empty. Customer is excluded if any condition matches.';

                    return (
                      <div
                        key={groupKey}
                        style={{
                          padding: 18,
                          borderRadius: 10,
                          background: 'rgba(0, 0, 0, 0.25)',
                          border: '1px solid var(--border-color)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 14,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                          <div>
                            <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.9rem' }}>
                              {groupTitle}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              {groupDesc}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleAddAudienceRule(groupKey)}
                            className="btn btn-secondary"
                            style={{ fontSize: '0.75rem', padding: '5px 12px' }}
                          >
                            <Plus size={13} style={{ marginRight: 4 }} />
                            Add Condition
                          </button>
                        </div>

                        {groupRules.length === 0 ? (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            No conditions defined for {groupKey}.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {groupRules.map((rule, rIdx) => {
                              const isBooleanField = rule.field === 'serviceIssueOpen' || rule.field === 'isLive';
                              const isNumericField = rule.field === 'preferences.budgetMaxPaise';
                              const isArrayOp = rule.op === 'in' || rule.op === 'nin';

                              return (
                                <div
                                  key={rIdx}
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'minmax(180px, 1fr) minmax(130px, 160px) minmax(180px, 1fr) 40px',
                                    gap: 10,
                                    alignItems: 'center',
                                  }}
                                >
                                  {/* Field */}
                                  <select
                                    value={rule.field}
                                    onChange={(e) => {
                                      const nextField = e.target.value as any;
                                      let nextVal = rule.value;
                                      if (nextField === 'serviceIssueOpen' || nextField === 'isLive') nextVal = false;
                                      else if (nextField === 'preferences.budgetMaxPaise') nextVal = 500000;
                                      else if (nextField === 'customer.status') nextVal = 'ACTIVE';
                                      else if (nextField === 'tags') nextVal = 'VIP';
                                      handleUpdateAudienceRule(groupKey, rIdx, { field: nextField, value: nextVal });
                                    }}
                                    style={{
                                      padding: '8px 10px',
                                      borderRadius: 6,
                                      backgroundColor: '#111827',
                                      border: '1px solid var(--border-color)',
                                      color: '#fff',
                                      fontSize: '0.8rem',
                                      colorScheme: 'dark',
                                    }}
                                  >
                                    {ALLOWED_AUDIENCE_FIELDS.map((f) => (
                                      <option key={f} value={f} style={{ backgroundColor: '#111827', color: '#fff' }}>
                                        {f}
                                      </option>
                                    ))}
                                  </select>

                                  {/* Operator */}
                                  <select
                                    value={rule.op}
                                    onChange={(e) =>
                                      handleUpdateAudienceRule(groupKey, rIdx, { op: e.target.value as any })
                                    }
                                    style={{
                                      padding: '8px 10px',
                                      borderRadius: 6,
                                      backgroundColor: '#111827',
                                      border: '1px solid var(--border-color)',
                                      color: '#fff',
                                      fontSize: '0.8rem',
                                      colorScheme: 'dark',
                                    }}
                                  >
                                    {ALLOWED_AUDIENCE_OPERATORS.map((op) => (
                                      <option key={op} value={op} style={{ backgroundColor: '#111827', color: '#fff' }}>
                                        {op}
                                      </option>
                                    ))}
                                  </select>

                                  {/* Value */}
                                  {isBooleanField ? (
                                    <select
                                      value={String(rule.value)}
                                      onChange={(e) =>
                                        handleUpdateAudienceRule(groupKey, rIdx, { value: e.target.value === 'true' })
                                      }
                                      style={{
                                        padding: '8px 10px',
                                        borderRadius: 6,
                                        backgroundColor: '#111827',
                                        border: '1px solid var(--border-color)',
                                        color: '#fff',
                                        fontSize: '0.8rem',
                                        colorScheme: 'dark',
                                      }}
                                    >
                                      <option value="true" style={{ backgroundColor: '#111827', color: '#fff' }}>true</option>
                                      <option value="false" style={{ backgroundColor: '#111827', color: '#fff' }}>false</option>
                                    </select>
                                  ) : isNumericField ? (
                                    <input
                                      type="number"
                                      value={rule.value ?? 0}
                                      onChange={(e) =>
                                        handleUpdateAudienceRule(groupKey, rIdx, {
                                          value: parseFloat(e.target.value) || 0,
                                        })
                                      }
                                      placeholder="Paise (e.g. 500000 = ₹5,000)"
                                      style={{
                                        padding: '8px 10px',
                                        borderRadius: 6,
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: '1px solid var(--border-color)',
                                        color: '#fff',
                                        fontSize: '0.8rem',
                                      }}
                                    />
                                  ) : isArrayOp ? (
                                    <input
                                      type="text"
                                      value={Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value || '')}
                                      onChange={(e) => {
                                        const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                                        handleUpdateAudienceRule(groupKey, rIdx, { value: parts });
                                      }}
                                      placeholder="Comma-separated values (e.g. VIP, Gold)"
                                      style={{
                                        padding: '8px 10px',
                                        borderRadius: 6,
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: '1px solid var(--border-color)',
                                        color: '#fff',
                                        fontSize: '0.8rem',
                                      }}
                                    />
                                  ) : (
                                    <input
                                      type="text"
                                      value={typeof rule.value === 'string' ? rule.value : ''}
                                      onChange={(e) =>
                                        handleUpdateAudienceRule(groupKey, rIdx, { value: e.target.value })
                                      }
                                      placeholder="Target value (e.g. Silk, Banarasi, Chennai)"
                                      style={{
                                        padding: '8px 10px',
                                        borderRadius: 6,
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: '1px solid var(--border-color)',
                                        color: '#fff',
                                        fontSize: '0.8rem',
                                      }}
                                    />
                                  )}

                                  {/* Delete Rule */}
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveAudienceRule(groupKey, rIdx)}
                                    className="btn btn-secondary"
                                    style={{ padding: '8px', color: 'var(--accent-rose)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                    title="Delete Condition"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Mandatory Platform Gates Checklist (Spec p10) */}
              <div>
                <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
                  Mandatory Platform Pre-Send Gates (Always Applied):
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
                  <div className="glass-panel" style={{ padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                      <CheckCircle2 size={16} color="var(--accent-emerald)" />
                      Active Customer Status
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      Deleted, suspended, or archived customers are skipped automatically.
                    </div>
                  </div>

                  <div className="glass-panel" style={{ padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                      <CheckCircle2 size={16} color="var(--accent-emerald)" />
                      Verified Destination
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      Encrypted phone with SHA-256 destination hash and sandbox allowlist check.
                    </div>
                  </div>

                  <div className="glass-panel" style={{ padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                      <CheckCircle2 size={16} color="var(--accent-emerald)" />
                      Marketing Consent
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      Strict marketing opt-in required. Channel suppression cancels pending work.
                    </div>
                  </div>

                  <div className="glass-panel" style={{ padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                      <CheckCircle2 size={16} color="var(--accent-emerald)" />
                      Collision Arbitrage
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      1 contact / 24h & 3 contacts / 7d rolling contact ledger caps.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: MESSAGES & TEMPLATE MAPPING */}
          {activeStep === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                    Step 3: Message Steps & Template Mapping
                  </h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    Configure 1 to 3 sequential steps. Each step binds one approved WhatsApp template with strictly increasing offsets.
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleCheckSuggestionsDiff}
                    className="btn btn-secondary"
                    style={{ fontSize: '0.8rem', padding: '7px 14px', borderColor: 'rgba(99, 102, 241, 0.4)', color: 'var(--accent-indigo)' }}
                  >
                    <Sparkles size={14} style={{ marginRight: 4 }} />
                    Auto-Fill Suggestions (Diff)
                  </button>

                  <button
                    type="button"
                    onClick={handleAutoFillRecommendedTemplates}
                    className="btn btn-secondary"
                    style={{ fontSize: '0.8rem', padding: '7px 14px', borderColor: 'rgba(255, 255, 255, 0.15)' }}
                  >
                    Preset Defaults
                  </button>

                  <button
                    type="button"
                    onClick={handleAddStep}
                    disabled={draft.steps.length >= 3}
                    className="btn btn-primary"
                    style={{ fontSize: '0.8rem', padding: '7px 14px' }}
                  >
                    <Plus size={15} />
                    Add Step ({draft.steps.length}/3)
                  </button>
                </div>
              </div>

              {autoFillNotice && (
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: 'rgba(16, 185, 129, 0.1)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    color: '#a7f3d0',
                    fontSize: '0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <CheckCircle2 size={16} color="var(--accent-emerald)" />
                  <span>{autoFillNotice}</span>
                </div>
              )}

              {/* Step 3 Template Selection Guide */}
              <div
                className="glass-panel"
                style={{
                  padding: '14px 18px',
                  background: 'rgba(99, 102, 241, 0.08)',
                  borderColor: 'rgba(99, 102, 241, 0.25)',
                  fontSize: '0.85rem',
                  color: '#c7d2fe',
                  lineHeight: 1.5,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 14,
                }}
              >
                <div>
                  <strong style={{ color: '#fff' }}>Template Selection Guide:</strong> Each step in your campaign requires an approved template. For Welcome Campaign, map Step 1 to <em>welcome_new_customer</em> or <em>welcome_new_customer_offer</em>. For Birthday Celebration, click <strong style={{ color: '#fff' }}>Auto-Fill Recommended Templates</strong>.
                </div>
              </div>

              {/* Event Delay Notice Banner */}
              {draft.trigger?.type === 'EVENT_DELAY' && (
                <div
                  className="glass-panel"
                  style={{
                    padding: '14px 18px',
                    background: 'rgba(59, 130, 246, 0.08)',
                    borderColor: 'rgba(59, 130, 246, 0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    fontSize: '0.85rem',
                    color: '#93c5fd',
                  }}
                >
                  <Info size={18} color="var(--accent-cyan)" style={{ flexShrink: 0 }} />
                  <div>
                    <strong style={{ color: '#fff' }}>
                      {draft.trigger.anchor === 'FIRST_QUALIFYING_ORDER'
                        ? 'First-to-Second Purchase Bring-Back Notice:'
                        : 'Welcome Campaign Notice:'}
                    </strong>{' '}
                    {draft.trigger.anchor === 'FIRST_QUALIFYING_ORDER'
                      ? 'Anchored to the customer\'s first completed qualifying order. Evaluates delay (e.g., +30 days), respects quiet hours, and halts automatically on a second qualifying order.'
                      : 'Sent after a customer\'s first paid purchase. Halts if repeat purchase occurs.'}
                  </div>
                </div>
              )}

              {/* Step Cards List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {draft.steps.map((step, idx) => {
                  const selectedTemplate = templates.find((t) => t.id === step.templateRef?.id);
                  const isUtilityTest =
                    selectedTemplate && selectedTemplate.category !== 'MARKETING';

                  return (
                    <div
                      key={idx}
                      className="glass-panel"
                      style={{
                        padding: 24,
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 18,
                      }}
                    >
                      {/* Step Header */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            style={{
                              width: 26,
                              height: 26,
                              borderRadius: '50%',
                              background: 'var(--accent-indigo)',
                              color: '#fff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 700,
                              fontSize: '0.8rem',
                            }}
                          >
                            {idx + 1}
                          </span>
                          <span style={{ fontWeight: 700, color: '#fff', fontSize: '1.05rem' }}>
                            {step.stepName || `Step ${idx + 1}`} ({step.stepId})
                          </span>
                        </div>

                        {draft.steps.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveStep(idx)}
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: '0.75rem', color: 'var(--accent-rose)' }}
                          >
                            <Trash2 size={13} style={{ marginRight: 4 }} />
                            Remove Step
                          </button>
                        )}
                      </div>

                      {/* Step Controls */}
                      {draft.trigger?.type === 'EVENT_DELAY' || draft.trigger?.type === 'ENQUIRY_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION' ? (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
                          <div style={{ gridColumn: 'span 2' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>
                                {draft.trigger?.type === 'ENQUIRY_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION'
                                  ? "Delay from Customer's Last Interaction (the same anchor for every step)"
                                  : 'Dispatch Delay & Presets'}
                              </label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {(draft.trigger?.type === 'ENQUIRY_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION'
                                  ? [
                                      { label: '+24h (default 1)', unit: 'HOURS', val: 24 },
                                      { label: '+48h', unit: 'HOURS', val: 48 },
                                      { label: '+72h (default 2)', unit: 'HOURS', val: 72 },
                                      { label: '+7d', unit: 'DAYS', val: 7 },
                                    ]
                                  : [
                                      { label: 'Immediately (0m)', unit: 'MINUTES', val: 0 },
                                      { label: '15m', unit: 'MINUTES', val: 15 },
                                      { label: '1h (default)', unit: 'HOURS', val: 1 },
                                      { label: '24h', unit: 'HOURS', val: 24 },
                                    ]
                                ).map((p) => {
                                  const currentVal = step.delay?.value ?? (step as any).delayValue ?? 1;
                                  const currentUnit = step.delay?.unit || (step as any).delayUnit || 'HOURS';
                                  const isSelected = currentUnit === p.unit && currentVal === p.val;
                                  return (
                                    <button
                                      key={p.label}
                                      type="button"
                                      onClick={() => {
                                        handleUpdateStep(idx, {
                                          delay: { unit: p.unit as any, value: p.val },
                                          delayUnit: p.unit,
                                          delayValue: p.val,
                                        } as any);
                                      }}
                                      style={{
                                        fontSize: '0.72rem',
                                        padding: '3px 8px',
                                        borderRadius: 6,
                                        border: isSelected
                                          ? '1px solid var(--accent-indigo)'
                                          : '1px solid rgba(255, 255, 255, 0.1)',
                                        background: isSelected
                                          ? 'rgba(99, 102, 241, 0.25)'
                                          : 'rgba(255, 255, 255, 0.04)',
                                        color: isSelected ? '#fff' : 'var(--text-muted)',
                                        cursor: 'pointer',
                                        fontWeight: isSelected ? 700 : 500,
                                      }}
                                    >
                                      {p.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <input
                                id={`step-${idx}-delay-value`}
                                type="number"
                                min={0}
                                max={
                                  (step.delay?.unit || (step as any).delayUnit) === 'MINUTES'
                                    ? 1440
                                    : (step.delay?.unit || (step as any).delayUnit) === 'DAYS'
                                    ? 30
                                    : 168
                                }
                                value={step.delay?.value ?? (step as any).delayValue ?? 1}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value, 10) || 0;
                                  const currentUnit = step.delay?.unit || (step as any).delayUnit || 'HOURS';
                                  handleUpdateStep(idx, {
                                    delay: { unit: currentUnit, value: val },
                                    delayValue: val,
                                    delayUnit: currentUnit,
                                  } as any);
                                }}
                                style={{
                                  width: '90px',
                                  padding: '8px 12px',
                                  borderRadius: 8,
                                  background: 'rgba(255, 255, 255, 0.05)',
                                  border: '1px solid var(--border-color)',
                                  color: '#fff',
                                  fontSize: '0.875rem',
                                }}
                              />
                              <select
                                id={`step-${idx}-delay-unit`}
                                value={step.delay?.unit || (step as any).delayUnit || 'HOURS'}
                                onChange={(e) => {
                                  const unit = e.target.value as 'MINUTES' | 'HOURS' | 'DAYS';
                                  const currentVal = step.delay?.value ?? (step as any).delayValue ?? 1;
                                  handleUpdateStep(idx, {
                                    delay: { unit, value: currentVal },
                                    delayUnit: unit,
                                    delayValue: currentVal,
                                  } as any);
                                }}
                                style={{
                                  flex: 1,
                                  padding: '8px 12px',
                                  borderRadius: 8,
                                  backgroundColor: '#111827',
                                  border: '1px solid var(--border-color)',
                                  color: '#fff',
                                  fontSize: '0.875rem',
                                  colorScheme: 'dark',
                                }}
                              >
                                <option value="MINUTES">Minutes after qualifying event</option>
                                <option value="HOURS">Hours after qualifying event</option>
                                <option value="DAYS">Days after qualifying event</option>
                              </select>
                            </div>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                              Calculates raw due instant relative to anchor event occurredAt. Sending hours gate (10:00 - 19:00 IST) is applied on top.
                            </span>
                          </div>

                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                              Outside Hours Policy
                            </label>
                            <select
                              id={`step-${idx}-outside-hours-policy`}
                              value={step.outsideHoursPolicy || 'DEFER_NEXT_DAY'}
                              onChange={(e) =>
                                handleUpdateStep(idx, { outsideHoursPolicy: e.target.value as 'DEFER_NEXT_DAY' | 'SKIP' })
                              }
                              style={{
                                width: '100%',
                                padding: '8px 12px',
                                borderRadius: 8,
                                backgroundColor: '#111827',
                                border: '1px solid var(--border-color)',
                                color: '#fff',
                                fontSize: '0.875rem',
                                colorScheme: 'dark',
                              }}
                            >
                              <option value="DEFER_NEXT_DAY">DEFER_NEXT_DAY (Defer to 10:00 next day)</option>
                              <option value="SKIP">SKIP (Skip dispatch if outside sending hours)</option>
                            </select>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2, display: 'block' }}>
                              Allowed sending hours: 10:00 - 19:00 IST.
                            </span>
                          </div>

                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                              Max Deferral Hours (0-48)
                            </label>
                            <input
                              id={`step-${idx}-max-deferral-hours`}
                              type="number"
                              min={0}
                              max={48}
                              value={step.maxDeferralHours ?? 24}
                              onChange={(e) =>
                                handleUpdateStep(idx, { maxDeferralHours: parseInt(e.target.value, 10) || 0 })
                              }
                              style={{
                                width: '100%',
                                padding: '8px 12px',
                                borderRadius: 8,
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid var(--border-color)',
                                color: '#fff',
                                fontSize: '0.875rem',
                              }}
                            />
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2, display: 'block' }}>
                              If deferral exceeds limit, message is skipped.
                            </span>
                          </div>

                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                              Prerequisite
                            </label>
                            <select
                              disabled={idx === 0}
                              value={idx === 0 ? 'NONE' : step.prerequisite}
                              onChange={(e) =>
                                handleUpdateStep(idx, { prerequisite: e.target.value as any })
                              }
                              style={{
                                width: '100%',
                                padding: '8px 12px',
                                borderRadius: 8,
                                backgroundColor: '#111827',
                                border: '1px solid var(--border-color)',
                                color: idx === 0 ? 'var(--text-muted)' : '#fff',
                                fontSize: '0.875rem',
                                colorScheme: 'dark',
                              }}
                            >
                              <option value="NONE" style={{ backgroundColor: '#111827', color: '#fff' }}>
                                NONE - Always eligible when due
                              </option>
                              <option value="PREVIOUS_ACCEPTED" style={{ backgroundColor: '#111827', color: '#fff' }}>
                                PREVIOUS_ACCEPTED - Require prior step acceptance
                              </option>
                            </select>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                              Schedule Offset (Days)
                            </label>
                            <input
                              type="number"
                              value={step.offsetDays ?? 0}
                              onChange={(e) =>
                                handleUpdateStep(idx, { offsetDays: parseInt(e.target.value) || 0 })
                              }
                              style={{
                                width: '100%',
                                padding: '8px 12px',
                                borderRadius: 8,
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid var(--border-color)',
                                color: '#fff',
                                fontSize: '0.875rem',
                              }}
                            />
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2, display: 'block' }}>
                              {(step.offsetDays ?? 0) < 0
                                ? `${Math.abs(step.offsetDays ?? 0)} days before occasion`
                                : (step.offsetDays ?? 0) === 0
                                ? 'On occasion date'
                                : `${step.offsetDays} days after occasion`}
                            </span>
                          </div>

                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                              Local Send Time (HH:mm)
                            </label>
                            <input
                              type="text"
                              value={step.localTime}
                              onChange={(e) => handleUpdateStep(idx, { localTime: e.target.value })}
                              placeholder="10:00"
                              style={{
                                width: '100%',
                                padding: '8px 12px',
                                borderRadius: 8,
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid var(--border-color)',
                                color: '#fff',
                                fontSize: '0.875rem',
                              }}
                            />
                          </div>

                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                              Prerequisite
                            </label>
                            <select
                              disabled={idx === 0}
                              value={idx === 0 ? 'NONE' : step.prerequisite}
                              onChange={(e) =>
                                handleUpdateStep(idx, { prerequisite: e.target.value as any })
                              }
                              style={{
                                width: '100%',
                                padding: '8px 12px',
                                borderRadius: 8,
                                backgroundColor: '#111827',
                                border: '1px solid var(--border-color)',
                                color: idx === 0 ? 'var(--text-muted)' : '#fff',
                                fontSize: '0.875rem',
                                colorScheme: 'dark',
                              }}
                            >
                              <option value="NONE" style={{ backgroundColor: '#111827', color: '#fff' }}>
                                NONE - Always eligible when due
                              </option>
                              <option value="PREVIOUS_ACCEPTED" style={{ backgroundColor: '#111827', color: '#fff' }}>
                                PREVIOUS_ACCEPTED - Require prior step delivery acceptance
                              </option>
                            </select>
                          </div>
                        </div>
                      )}

                      {/* Template Selector */}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>
                            WhatsApp Template
                          </label>
                          {selectedTemplate ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              {isUtilityTest && (
                                <span className="badge badge-amber" style={{ fontSize: '0.7rem' }}>
                                  TEST ONLY: category mismatch
                                </span>
                              )}
                              {!selectedTemplate.sendable && (
                                <span className="badge badge-rose" style={{ fontSize: '0.7rem' }}>
                                  dummy template: cannot be sent
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="badge badge-rose" style={{ fontSize: '0.7rem' }}>
                              Template Required
                            </span>
                          )}
                        </div>

                        <select
                          value={step.templateRef?.id || ''}
                          onChange={(e) => handleSelectTemplate(idx, e.target.value)}
                          style={{
                            width: '100%',
                            padding: '10px 14px',
                            borderRadius: 8,
                            backgroundColor: '#111827',
                            border: '1px solid var(--border-color)',
                            color: '#fff',
                            fontSize: '0.875rem',
                            colorScheme: 'dark',
                          }}
                        >
                          <option value="" style={{ backgroundColor: '#111827', color: '#94a3b8' }}>
                            -- Select Approved Template from Catalogue --
                          </option>
                          {templates.map((tpl) => (
                            <option
                              key={tpl.id}
                              value={tpl.id}
                              style={{ backgroundColor: '#111827', color: '#fff' }}
                            >
                              {tpl.name} ({tpl.language}, rev {tpl.revision}) - {tpl.category}{' '}
                              {!tpl.sendable ? '[DUMMY PREVIEW]' : ''}
                            </option>
                          ))}
                        </select>
                        <span style={{ fontSize: '0.75rem', color: step.templateRef ? 'var(--accent-emerald)' : 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                          {step.templateRef
                            ? `\u2713 Selected: ${step.templateRef.id} (rev ${step.templateRef.revision}, ${step.templateRef.language})`
                            : 'Select an approved template from catalogue (e.g. birthday_invite for step 1, birthday_followup for step 2, hello_world for step 3)'}
                        </span>

                        {/* Today / Tonight Warning for DEFER_NEXT_DAY */}
                        {(() => {
                          const body = selectedTemplate?.bodyText || '';
                          const hasTodayTonight = /\b(today|tonight)\b/i.test(body);
                          const isDefer = (step.outsideHoursPolicy || 'DEFER_NEXT_DAY') === 'DEFER_NEXT_DAY';
                          if (hasTodayTonight && isDefer) {
                            return (
                              <div
                                style={{
                                  marginTop: 8,
                                  padding: '10px 14px',
                                  borderRadius: 8,
                                  background: 'rgba(245, 158, 11, 0.1)',
                                  border: '1px solid rgba(245, 158, 11, 0.3)',
                                  color: '#fde68a',
                                  fontSize: '0.8rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                }}
                              >
                                <AlertTriangle size={15} color="var(--accent-amber)" style={{ flexShrink: 0 }} />
                                <span>
                                  <strong>Notice:</strong> Template body references &quot;today&quot; or &quot;tonight&quot; while outside-hours policy is DEFER_NEXT_DAY. If an evening or night order is deferred to next morning (10:00 AM), recipients might find this phrasing confusing.
                                </span>
                              </div>
                            );
                          }
                          return null;
                        })()}

                        {/* RESERVATION_WORDING Warning */}
                        {(() => {
                          const body = selectedTemplate?.bodyText || '';
                          const hasReservation = /(reserved|reserve|"held for you"|"kept aside"|"on hold for you"|guarantee)/i.test(body);
                          if (hasReservation) {
                            return (
                              <div
                                style={{
                                  marginTop: 8,
                                  padding: '10px 14px',
                                  borderRadius: 8,
                                  background: 'rgba(239, 68, 68, 0.1)',
                                  border: '1px solid rgba(239, 68, 68, 0.3)',
                                  color: '#fecdd3',
                                  fontSize: '0.8rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                }}
                              >
                                <AlertTriangle size={15} color="var(--accent-rose)" style={{ flexShrink: 0 }} />
                                <span>
                                  <strong>WARNING (RESERVATION_WORDING):</strong> Template body implies an item is reserved. Spec p13: a follow-up never reserves an item.
                                </span>
                              </div>
                            );
                          }
                          return null;
                        })()}

                        {/* ITEM_BINDING_NEEDS_ITEM Warning */}
                        {(() => {
                          const isEnquiry =
                            draft.trigger?.type === 'ENQUIRY_EVENT_DELAY' ||
                            (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION';
                          const bindsItem = Object.values(step.bindings || {}).some(
                            (b) => b === 'item.name' || (typeof b === 'object' && (b as any).source === 'item.name')
                          );
                          if (isEnquiry && bindsItem && !(draft as any).requireItem) {
                            return (
                              <div
                                style={{
                                  marginTop: 8,
                                  padding: '10px 14px',
                                  borderRadius: 8,
                                  background: 'rgba(245, 158, 11, 0.1)',
                                  border: '1px solid rgba(245, 158, 11, 0.3)',
                                  color: '#fde68a',
                                  fontSize: '0.8rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                }}
                              >
                                <AlertTriangle size={15} color="var(--accent-amber)" style={{ flexShrink: 0 }} />
                                <span>
                                  <strong>WARNING (ITEM_BINDING_NEEDS_ITEM):</strong> Template binds <em>item.name</em> but <em>requireItem</em> is false. Enquiries without an item will skip or use fallbackLiteral.
                                </span>
                              </div>
                            );
                          }
                          return null;
                        })()}

                        {/* Store Offer Selector (OfferRef) */}
                        {(() => {
                          const needsOffer =
                            selectedTemplate?.variables?.some((v) => v.name?.includes('offer')) ||
                            Object.values(step.bindings || {}).some(
                              (b) => b === 'offer.amountRupees' || (typeof b === 'object' && (b as any).source === 'offer.amountRupees')
                            );

                          if (needsOffer || draft.trigger?.type === 'EVENT_DELAY') {
                            return (
                              <div style={{ marginTop: 12 }}>
                                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                                  Store Offer (OfferRef)
                                </label>
                                <select
                                  id={`step-${idx}-offer-ref`}
                                  value={step.offerRef?.offerId || ''}
                                  onChange={(e) =>
                                    handleUpdateStep(idx, {
                                      offerRef: e.target.value
                                        ? { offerId: e.target.value }
                                        : undefined,
                                    })
                                  }
                                  style={{
                                    width: '100%',
                                    padding: '8px 12px',
                                    borderRadius: 8,
                                    backgroundColor: '#111827',
                                    border: '1px solid var(--border-color)',
                                    color: '#fff',
                                    fontSize: '0.85rem',
                                    colorScheme: 'dark',
                                  }}
                                >
                                  <option value="">-- Select Store Offer --</option>
                                  {offers.map((off) => (
                                    <option key={off.offerId} value={off.offerId}>
                                      {off.offerId} (₹{off.amountPaise / 100} off) - {off.status}
                                    </option>
                                  ))}
                                </select>
                                <span
                                  style={{
                                    fontSize: '0.7rem',
                                    color: step.offerRef ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                                    marginTop: 2,
                                    display: 'block',
                                  }}
                                >
                                  {step.offerRef
                                    ? `\u2713 Linked offer: ${step.offerRef.offerId}`
                                    : 'Select an active offer from your store catalogue (e.g. off_welcome_50) to resolve offer.amountRupees.'}
                                </span>
                              </div>
                            );
                          }
                          return null;
                        })()}
                      </div>

                      {/* Variable Bindings Editor */}
                      {selectedTemplate && (
                        <div
                          style={{
                            padding: 18,
                            borderRadius: 10,
                            background: 'rgba(0, 0, 0, 0.25)',
                            border: '1px solid var(--border-color)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                            <div>
                              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff' }}>
                                Template Parameter Mapping ({selectedTemplate.variables?.length || 0} Required)
                              </div>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Map each template variable {'{{index}}'} to an allowed recipient CRM field, store context, or sanitized literal.
                              </span>
                            </div>
                            <span className="badge badge-indigo" style={{ fontSize: '0.7rem' }}>
                              Schema v2 Hardened
                            </span>
                          </div>

                          {!selectedTemplate.variables || selectedTemplate.variables.length === 0 ? (
                            <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                              This template has zero variables. No parameter components required.
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                              {selectedTemplate.variables.map((v) => {
                                const bindingEntry = step.bindings?.[String(v.index)];
                                let selectedSource = 'customer.firstName';
                                let literalString = '';
                                let fallbackString = '';

                                if (typeof bindingEntry === 'string') {
                                  if (bindingEntry.startsWith('literal:')) {
                                    selectedSource = 'literal';
                                    literalString = bindingEntry.replace('literal:', '');
                                  } else {
                                    selectedSource = bindingEntry;
                                  }
                                } else if (bindingEntry && typeof bindingEntry === 'object') {
                                  selectedSource = (bindingEntry.source as string) || 'customer.firstName';
                                  if (bindingEntry.source === 'literal') {
                                    literalString = bindingEntry.value || '';
                                  }
                                  fallbackString = (bindingEntry as any).fallbackLiteral || '';
                                }

                                const isLiteral = selectedSource === 'literal';
                                const isCustomerName = selectedSource === 'customer.firstName';
                                const isLiteralTooLong = isLiteral && literalString.length > 200;
                                const isLiteralInvalidChars = isLiteral && /[\n\t]/.test(literalString);

                                return (
                                  <div
                                    key={v.index}
                                    style={{
                                      padding: '12px 16px',
                                      borderRadius: 8,
                                      background: 'rgba(255, 255, 255, 0.03)',
                                      border: '1px solid rgba(255, 255, 255, 0.08)',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 10,
                                    }}
                                  >
                                    <div
                                      style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'minmax(140px, 180px) minmax(200px, 240px) 1fr',
                                        gap: 14,
                                        alignItems: 'center',
                                      }}
                                    >
                                      {/* Variable identifier */}
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span
                                          style={{
                                            fontFamily: 'var(--font-mono)',
                                            color: 'var(--accent-cyan)',
                                            fontWeight: 700,
                                            fontSize: '0.85rem',
                                            padding: '2px 8px',
                                            borderRadius: 4,
                                            background: 'rgba(6, 182, 212, 0.12)',
                                          }}
                                        >
                                          {`{{${v.index}}}`}
                                        </span>
                                        <div style={{ fontSize: '0.8rem', color: '#fff', fontWeight: 600 }}>
                                          {v.name || `Parameter ${v.index}`}
                                        </div>
                                      </div>

                                      {/* Source selector */}
                                      <select
                                        value={selectedSource}
                                        onChange={(e) =>
                                          handleUpdateBinding(idx, v.index, e.target.value, literalString, fallbackString)
                                        }
                                        style={{
                                          padding: '7px 12px',
                                          borderRadius: 6,
                                          backgroundColor: '#111827',
                                          border: '1px solid var(--border-color)',
                                          color: '#fff',
                                          fontSize: '0.85rem',
                                          colorScheme: 'dark',
                                        }}
                                      >
                                        {ALLOWED_BINDING_SOURCES.map((source) => (
                                          <option key={source} value={source} style={{ backgroundColor: '#111827', color: '#fff' }}>
                                            {source === 'literal' ? 'Literal Text Value' : source}
                                          </option>
                                        ))}
                                      </select>

                                      {/* Configuration column */}
                                      <div>
                                        {isLiteral ? (
                                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                              <input
                                                type="text"
                                                placeholder="Type explicit literal text..."
                                                value={literalString}
                                                onChange={(e) =>
                                                  handleUpdateBinding(idx, v.index, 'literal', e.target.value, fallbackString)
                                                }
                                                style={{
                                                  flex: 1,
                                                  padding: '7px 12px',
                                                  borderRadius: 6,
                                                  background: 'rgba(255, 255, 255, 0.05)',
                                                  border: isLiteralTooLong ? '1px solid var(--accent-rose)' : '1px solid var(--border-color)',
                                                  color: '#fff',
                                                  fontSize: '0.85rem',
                                                }}
                                              />
                                              <span
                                                style={{
                                                  fontSize: '0.75rem',
                                                  fontFamily: 'var(--font-mono)',
                                                  color: isLiteralTooLong ? 'var(--accent-rose)' : 'var(--text-muted)',
                                                  fontWeight: isLiteralTooLong ? 700 : 500,
                                                  minWidth: 50,
                                                  textAlign: 'right',
                                                }}
                                              >
                                                {literalString.length}/200
                                              </span>
                                            </div>
                                            {isLiteralTooLong && (
                                              <span style={{ fontSize: '0.7rem', color: 'var(--accent-rose)' }}>
                                                ⚠ Exceeds 200 character limit (WhatsApp Cloud API rejects parameters over 200 characters)
                                              </span>
                                            )}
                                            {isLiteralInvalidChars && (
                                              <span style={{ fontSize: '0.7rem', color: 'var(--accent-amber)' }}>
                                                Notice: Newlines (\n) and tabs (\t) are stripped or replaced with single spaces upon delivery
                                              </span>
                                            )}
                                          </div>
                                        ) : isCustomerName ? (
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <input
                                              type="text"
                                              placeholder="Fallback literal (e.g. Valued Customer)..."
                                              value={fallbackString}
                                              onChange={(e) =>
                                                handleUpdateBinding(idx, v.index, 'customer.firstName', literalString, e.target.value)
                                              }
                                              style={{
                                                flex: 1,
                                                padding: '7px 12px',
                                                borderRadius: 6,
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                border: '1px solid var(--border-color)',
                                                color: '#fff',
                                                fontSize: '0.85rem',
                                              }}
                                            />
                                            {fallbackString && (
                                              <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                                                {fallbackString.length}/200
                                              </span>
                                            )}
                                          </div>
                                        ) : selectedSource === 'offer.amountRupees' ? (
                                          <div style={{ fontSize: '0.75rem', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span>✓ Linked from Step Store Offer ({step.offerRef?.offerId || 'offer required'})</span>
                                          </div>
                                        ) : selectedSource === 'credit.balanceDisplay' ? (
                                          <div style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)' }}>
                                            Format: Customer loyalty reward balance in Rupees (e.g. ₹150)
                                          </div>
                                        ) : (
                                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                            Example sample: &ldquo;{v.sample || 'Sample value'}&rdquo;
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    {/* Helper hint for customer.firstName */}
                                    {isCustomerName && (
                                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', paddingLeft: 4 }}>
                                        {fallbackString ? (
                                          <span style={{ color: 'var(--accent-emerald)' }}>
                                            ✓ Fallback active: &ldquo;{fallbackString}&rdquo; will be dispatched if customer name is missing.
                                          </span>
                                        ) : (
                                          <span style={{ color: 'var(--accent-amber)' }}>
                                            Tip: Set a fallback literal (e.g. &ldquo;Valued Customer&rdquo;) to prevent message skipping when recipient first name is empty.
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Stop Conditions & Lateness */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 24,
                          flexWrap: 'wrap',
                          paddingTop: 8,
                          borderTop: '1px solid var(--border-color)',
                        }}
                      >
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: '#fff', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={step.stopOnReply}
                            onChange={(e) => handleUpdateStep(idx, { stopOnReply: e.target.checked })}
                          />
                          Stop subsequent steps on customer reply (Staff Hold)
                        </label>

                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: '#fff', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={step.stopOnGoal}
                            onChange={(e) => handleUpdateStep(idx, { stopOnGoal: e.target.checked })}
                          />
                          Stop if customer purchases / completes goal
                        </label>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Max lateness:</span>
                          <input
                            type="number"
                            value={step.maxLatenessMinutes}
                            onChange={(e) =>
                              handleUpdateStep(idx, { maxLatenessMinutes: parseInt(e.target.value) || 120 })
                            }
                            style={{
                              width: 70,
                              padding: '4px 8px',
                              borderRadius: 6,
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: '1px solid var(--border-color)',
                              color: '#fff',
                              fontSize: '0.8rem',
                              textAlign: 'center',
                            }}
                          />
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>min</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* LIVE 5-CUSTOMER PREVIEW PANEL */}
              <div
                className="glass-panel"
                style={{
                  padding: 24,
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  background: 'linear-gradient(135deg, rgba(30, 27, 75, 0.4) 0%, rgba(15, 23, 42, 0.6) 100%)',
                  borderRadius: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Users size={18} color="var(--accent-cyan)" />
                      <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                        Live Message Preview (5 Diverse CRM Recipient Profiles)
                      </h4>
                      <span className="badge badge-indigo" style={{ fontSize: '0.7rem' }}>F19c Live Test Matrix</span>
                    </div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>
                      Canonical resolution simulation across real edge-case recipient records (empty names, whitespace, unicode, fallback literals).
                    </p>
                  </div>
                </div>

                {/* 5 Customer Tabs */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                  {SAMPLE_PREVIEW_CUSTOMERS.map((cust, cIdx) => {
                    const isSelected = previewCustomerIndex === cIdx;
                    return (
                      <button
                        key={cust.id}
                        type="button"
                        onClick={() => setPreviewCustomerIndex(cIdx)}
                        style={{
                          padding: '7px 14px',
                          borderRadius: 8,
                          background: isSelected ? 'var(--accent-indigo)' : 'rgba(255, 255, 255, 0.05)',
                          border: isSelected ? '1px solid var(--accent-indigo)' : '1px solid var(--border-color)',
                          color: '#fff',
                          fontSize: '0.8rem',
                          fontWeight: isSelected ? 700 : 500,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <span>{cust.label}</span>
                        <span
                          style={{
                            fontSize: '0.65rem',
                            padding: '2px 6px',
                            borderRadius: 10,
                            background: isSelected ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                            color: isSelected ? '#e0e7ff' : 'var(--text-muted)',
                          }}
                        >
                          {cust.badge}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Selected Customer Context Card */}
                {(() => {
                  const currentCustomer = SAMPLE_PREVIEW_CUSTOMERS[previewCustomerIndex];
                  const hasEmptyName = !currentCustomer.firstName.trim();

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div
                        style={{
                          padding: '12px 16px',
                          borderRadius: 8,
                          background: 'rgba(0, 0, 0, 0.3)',
                          border: '1px solid var(--border-color)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 12,
                          fontSize: '0.85rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: '50%',
                              background: 'rgba(99, 102, 241, 0.2)',
                              color: 'var(--accent-indigo)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 700,
                            }}
                          >
                            {currentCustomer.firstName.trim() ? currentCustomer.firstName.trim()[0] : '?'}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                              {currentCustomer.firstName || <em style={{ color: 'var(--accent-amber)' }}>[No First Name in CRM]</em>}
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                ({currentCustomer.maskedPhone})
                              </span>
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              Store: {currentCustomer.branch} &bull; Tags: {currentCustomer.tags.join(', ')}
                            </div>
                          </div>
                        </div>

                        {hasEmptyName && (
                          <div
                            style={{
                              padding: '6px 12px',
                              borderRadius: 6,
                              background: 'rgba(245, 158, 11, 0.15)',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                              color: '#fef3c7',
                              fontSize: '0.75rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <AlertTriangle size={14} color="var(--accent-amber)" />
                            <span>Empty name patron: will resolve using fallbackLiteral or skip if unset.</span>
                          </div>
                        )}
                      </div>

                      {/* Rendered Steps for this Customer */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                        {draft.steps.map((step, sIdx) => {
                          const tpl = templates.find((t) => t.id === step.templateRef?.id);
                          const linkedOffer = offers.find((o) => o.offerId === step.offerRef?.offerId);
                          const offerAmount = linkedOffer ? String(linkedOffer.amountPaise / 100) : '50';

                          const preview = renderLivePreviewText(
                            tpl,
                            step.bindings || {},
                            currentCustomer,
                            'Sample Boutique',
                            offerAmount
                          );

                          return (
                            <div
                              key={sIdx}
                              style={{
                                padding: 16,
                                borderRadius: 10,
                                background: 'rgba(0, 0, 0, 0.35)',
                                border: '1px solid var(--border-color)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 12,
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span className="badge badge-indigo" style={{ fontSize: '0.7rem' }}>
                                    Step {sIdx + 1}
                                  </span>
                                  <span style={{ fontWeight: 600, color: '#fff', fontSize: '0.85rem' }}>
                                    {tpl ? tpl.name : 'No Template'}
                                  </span>
                                </div>

                                {preview.usedFallback && (
                                  <span className="badge badge-emerald" style={{ fontSize: '0.7rem' }}>
                                    ✓ Fallback Used
                                  </span>
                                )}

                                {preview.problems.length > 0 && (
                                  <span className="badge badge-rose" style={{ fontSize: '0.7rem' }}>
                                    ⚠ Parameter Issue
                                  </span>
                                )}
                              </div>

                              {/* WhatsApp Chat Bubble */}
                              <div
                                style={{
                                  background: 'linear-gradient(180deg, #0b141a 0%, #111b21 100%)',
                                  border: '1px solid rgba(37, 211, 102, 0.2)',
                                  borderRadius: 12,
                                  padding: 14,
                                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 8,
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: '0.65rem', color: '#25d366', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                    WhatsApp Preview &bull; {tpl?.language || 'en'}
                                  </span>
                                  <span style={{ fontSize: '0.65rem', color: '#8696a0' }}>
                                    {step.localTime || '10:00 AM'}
                                  </span>
                                </div>

                                <div
                                  style={{
                                    background: '#005c4b',
                                    borderRadius: '8px 8px 2px 8px',
                                    padding: '10px 14px',
                                    color: '#e9edef',
                                    fontSize: '0.85rem',
                                    lineHeight: 1.5,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                  }}
                                >
                                  {preview.renderedText}
                                </div>

                                {/* Parameter resolution chips */}
                                {Object.keys(preview.paramValues).length > 0 && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                                    {Object.entries(preview.paramValues).map(([k, val]) => (
                                      <span
                                        key={k}
                                        style={{
                                          fontSize: '0.7rem',
                                          fontFamily: 'var(--font-mono)',
                                          padding: '2px 6px',
                                          borderRadius: 4,
                                          background: 'rgba(255, 255, 255, 0.08)',
                                          color: val.includes('{{') ? 'var(--accent-rose)' : '#a7f3d0',
                                        }}
                                      >
                                        {`{{${k}}}`}: &ldquo;{val}&rdquo;
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* Problem alerts if any */}
                              {preview.problems.length > 0 && (
                                <div style={{ fontSize: '0.75rem', color: 'var(--accent-rose)', lineHeight: 1.4 }}>
                                  {preview.problems.map((prob, pIdx) => (
                                    <div key={pIdx}>&bull; {prob}</div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* STEP 4: SENDING RULES & POLICY */}
          {activeStep === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                  Step 4: Campaign Sending Rules & Priority Policy
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  Define priority arbitrage and review inherited tenant marketing caps and outage policies.
                </p>
              </div>

              {/* Priority */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                  Campaign Arbitration Priority (1 - 100)
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.priority}
                  onChange={(e) => {
                    setDraft({ ...draft, priority: parseInt(e.target.value) || 80 });
                    setSaveStatus('unsaved');
                  }}
                  style={{
                    width: 140,
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid var(--border-color)',
                    color: '#fff',
                    fontSize: '0.9rem',
                  }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                  Spec p18 default: Birthday/Anniversary = 80. Wins over Festival (50) and Win-back (30) in collisions.
                </span>
              </div>

              {/* Inherited Tenant Policies */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
                <div className="glass-panel" style={{ padding: 18 }}>
                  <div style={{ fontWeight: 600, color: '#fff', marginBottom: 4, fontSize: '0.9rem' }}>
                    Tenant Frequency Caps
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    &bull; Max 1 marketing contact per rolling 24 hours<br />
                    &bull; Max 3 marketing contacts per rolling 7 days
                  </div>
                </div>

                <div className="glass-panel" style={{ padding: 18 }}>
                  <div style={{ fontWeight: 600, color: '#fff', marginBottom: 4, fontSize: '0.9rem' }}>
                    Outage & Resume Policy
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    &bull; Resume: <strong style={{ color: '#fff' }}>FUTURE_ONLY</strong> (No backlog bursts)<br />
                    &bull; Import: <strong style={{ color: '#fff' }}>FUTURE_ONLY</strong> (Future occurrences only)
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: REVIEW & VALIDATE */}
          {activeStep === 5 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                  Step 5: Review & Comprehensive Validation Report
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  The engine evaluates the entire campaign matrix. Inspect structured error field paths and resolution attribution.
                </p>
              </div>

              {/* Zero Live Sends Guarantee Banner */}
              <div
                className="glass-panel"
                style={{
                  padding: '16px 20px',
                  background: 'rgba(6, 182, 212, 0.08)',
                  borderColor: 'rgba(6, 182, 212, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                }}
              >
                <Info size={22} color="var(--accent-cyan)" style={{ flexShrink: 0 }} />
                <div style={{ fontSize: '0.875rem', color: '#cffafe', lineHeight: 1.5 }}>
                  <strong style={{ color: '#fff' }}>Zero Live Sends Guaranteed:</strong> Validation and dry run simulation
                  discover eligible customers, enforce mandatory pre-send gates and audience rules, calculate exact scheduled dates in
                  local and UTC time, and preview rendered WhatsApp messages. <strong style={{ color: '#fff' }}>No WhatsApp messages are sent, and no database enrollments or executions are created.</strong>
                </div>
              </div>

              {/* Action Buttons: Validate & Dry Run */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, color: '#fff', fontSize: '1rem' }}>
                    Current Status: <span className={`badge ${campaign.status === 'VALIDATED' ? 'badge-indigo' : 'badge-amber'}`}>{campaign.status}</span>
                  </div>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Validate template bindings or run an autonomous candidate dry run simulation.
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button
                    type="button"
                    onClick={runValidation}
                    disabled={validating}
                    className="btn btn-secondary"
                    style={{ padding: '10px 18px', fontSize: '0.85rem' }}
                  >
                    {validating ? (
                      <>
                        <Loader2 className="animate-spin" size={15} /> Evaluating Rules...
                      </>
                    ) : (
                      <>
                        <Sparkles size={15} /> Validate Rules
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={runDryRun}
                    disabled={runningDryRun}
                    className="btn btn-primary"
                    style={{ padding: '10px 20px', fontSize: '0.85rem' }}
                  >
                    {runningDryRun ? (
                      <>
                        <Loader2 className="animate-spin" size={15} /> Running Simulation...
                      </>
                    ) : (
                      <>
                        <Play size={15} /> Run Campaign Dry Run
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* In-Step Error Alert if Dry Run or Validation Failed */}
              {errorMsg && (
                <div
                  className="glass-panel"
                  style={{
                    padding: '16px 20px',
                    background: 'rgba(239, 68, 68, 0.12)',
                    borderColor: 'rgba(239, 68, 68, 0.4)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <AlertTriangle size={24} color="var(--accent-rose)" style={{ flexShrink: 0 }} />
                    <div>
                      <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.95rem' }}>
                        Dry Run Simulation Blocked
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#fecdd3', marginTop: 2 }}>
                        {errorMsg}
                      </div>
                    </div>
                  </div>
                  {errorMsg.toLowerCase().includes('template') && (
                    <button
                      type="button"
                      onClick={() => setActiveStep(3)}
                      className="btn btn-secondary"
                      style={{ fontSize: '0.85rem', padding: '8px 16px', flexShrink: 0 }}
                    >
                      Fix in Step 3: Messages &rarr;
                    </button>
                  )}
                </div>
              )}

              {/* Validation Report Results Display */}
              {validationReport && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {validationReport.valid ? (
                    <div
                      className="glass-panel"
                      style={{
                        padding: 20,
                        background: 'rgba(16, 185, 129, 0.1)',
                        borderColor: 'rgba(16, 185, 129, 0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                      }}
                    >
                      <CheckCircle2 size={28} color="var(--accent-emerald)" style={{ flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: '1.05rem' }}>
                          Draft Validated Successfully!
                        </div>
                        <div style={{ fontSize: '0.85rem', color: '#a7f3d0' }}>
                          Zero validation errors detected. All step offsets, triggers, templates, and bindings adhere strictly to spec rules.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="glass-panel"
                      style={{
                        padding: 20,
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderColor: 'rgba(239, 68, 68, 0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                      }}
                    >
                      <AlertTriangle size={28} color="var(--accent-rose)" style={{ flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: '1.05rem' }}>
                          Validation Failed: {validationReport.errors.length} Error(s) Found
                        </div>
                        <div style={{ fontSize: '0.85rem', color: '#fecdd3' }}>
                          Review the structured field paths and designated resolution owners below to resolve issues.
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Errors List */}
                  {validationReport.errors.length > 0 && (
                    <div>
                      <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginBottom: 10 }}>
                        Errors Blocking Validation ({validationReport.errors.length}):
                      </h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {validationReport.errors.map((err, i) => (
                          <div
                            key={i}
                            className="glass-panel"
                            style={{
                              padding: '12px 16px',
                              borderLeft: '4px solid var(--accent-rose)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 16,
                            }}
                          >
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '0.75rem',
                                    color: 'var(--accent-rose)',
                                    background: 'rgba(244, 63, 94, 0.12)',
                                    padding: '2px 8px',
                                    borderRadius: 4,
                                  }}
                                >
                                  {err.fieldPath}
                                </span>
                              </div>
                              <div style={{ fontSize: '0.875rem', color: '#fff' }}>{err.message}</div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              {err.fieldPath.includes('templateRef') && (
                                <button
                                  type="button"
                                  onClick={() => setActiveStep(3)}
                                  className="btn btn-secondary"
                                  style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                                >
                                  Select in Step 3 &rarr;
                                </button>
                              )}
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '3px 8px',
                                  borderRadius: 6,
                                  background:
                                    err.resolutionOwner === 'BOUTIQUE_OWNER'
                                      ? 'rgba(245, 158, 11, 0.15)'
                                      : 'rgba(6, 182, 212, 0.15)',
                                  color:
                                    err.resolutionOwner === 'BOUTIQUE_OWNER'
                                      ? 'var(--accent-amber)'
                                      : 'var(--accent-cyan)',
                                  border:
                                    err.resolutionOwner === 'BOUTIQUE_OWNER'
                                      ? '1px solid rgba(245, 158, 11, 0.3)'
                                      : '1px solid rgba(6, 182, 212, 0.3)',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                Owner: {err.resolutionOwner}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Warnings List */}
                  {validationReport.warnings.length > 0 && (
                    <div>
                      <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginBottom: 10 }}>
                        Warnings ({validationReport.warnings.length}):
                      </h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {validationReport.warnings.map((w, i) => (
                          <div
                            key={i}
                            className="glass-panel"
                            style={{
                              padding: '12px 16px',
                              borderLeft: '4px solid var(--accent-amber)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 16,
                            }}
                          >
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '0.75rem',
                                    color: 'var(--accent-amber)',
                                    background: 'rgba(245, 158, 11, 0.12)',
                                    padding: '2px 8px',
                                    borderRadius: 4,
                                  }}
                                >
                                  {w.fieldPath}
                                </span>
                              </div>
                              <div style={{ fontSize: '0.875rem', color: '#fff' }}>{w.message}</div>
                            </div>

                            <span
                              style={{
                                fontSize: '0.7rem',
                                padding: '3px 8px',
                                borderRadius: 6,
                                background: 'rgba(255, 255, 255, 0.05)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-color)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              Owner: {w.resolutionOwner}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Campaign Dry Run Simulation Results Panel (Feature 6: Spec p10, p29, p33) */}
              {dryRun && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: 24 }}>
                    <div>
                      <h4 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                        Campaign Dry Run Simulation
                      </h4>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        Zero live sends. Autonomous evaluation of candidate pool, pre-send gates, schedule calculation, and WhatsApp templates.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={runDryRun}
                      disabled={runningDryRun}
                      className="btn btn-secondary"
                      style={{ fontSize: '0.8rem', padding: '6px 14px' }}
                    >
                      {runningDryRun ? (
                        <>
                          <Loader2 className="animate-spin" size={14} /> Refreshing...
                        </>
                      ) : (
                        <>
                          <RefreshCw size={14} /> Re-run Dry Run
                        </>
                      )}
                    </button>
                  </div>

                  {/* Stale Draft Fingerprint Alert */}
                  {dryRun.isStale && (
                    <div
                      className="glass-panel"
                      style={{
                        padding: '14px 18px',
                        background: 'rgba(245, 158, 11, 0.12)',
                        border: '1px solid rgba(245, 158, 11, 0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 14,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <AlertTriangle size={20} color="var(--accent-amber)" style={{ flexShrink: 0 }} />
                        <div style={{ fontSize: '0.85rem', color: '#fef3c7' }}>
                          <strong style={{ color: '#fff' }}>Draft Modified (Stale Simulation):</strong> The campaign draft configuration has changed since this dry run was generated (fingerprint mismatch). Click &ldquo;Re-run Dry Run&rdquo; to refresh counts and plans.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={runDryRun}
                        disabled={runningDryRun}
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '5px 12px', whiteSpace: 'nowrap' }}
                      >
                        <RefreshCw size={13} />
                        Refresh
                      </button>
                    </div>
                  )}

                  {/* High-Level Simulation Metrics */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
                    <div className="glass-panel" style={{ padding: 16 }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                        Scanned Candidates
                      </div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff' }}>
                        {dryRun.counts.scanned}
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Branch-scoped store pool</span>
                    </div>

                    <div className="glass-panel" style={{ padding: 16, borderLeft: '4px solid var(--accent-emerald)' }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--accent-emerald)', textTransform: 'uppercase', marginBottom: 4 }}>
                        Eligible Recipients
                      </div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-emerald)' }}>
                        {dryRun.counts.eligible}
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {dryRun.counts.scanned > 0 ? Math.round((dryRun.counts.eligible / dryRun.counts.scanned) * 100) : 0}% qualification rate
                      </span>
                    </div>

                    <div className="glass-panel" style={{ padding: 16, borderLeft: '4px solid var(--accent-rose)' }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--accent-rose)', textTransform: 'uppercase', marginBottom: 4 }}>
                        Excluded Customers
                      </div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff' }}>
                        {dryRun.counts.excluded}
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Gated or filtered out</span>
                    </div>

                    <div className="glass-panel" style={{ padding: 16 }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                        Draft Fingerprint
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: 'var(--accent-cyan)', fontWeight: 600 }}>
                        {dryRun.draftFingerprint.slice(0, 10)}...
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        SHA-256 canonical
                      </span>
                    </div>

                    <div className="glass-panel" style={{ padding: 16 }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                        Evaluated At
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#fff', fontWeight: 600 }}>
                        {new Date(dryRun.evaluatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {new Date(dryRun.evaluatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  {/* Reason Breakdown */}
                  <div className="glass-panel" style={{ padding: 18 }}>
                    <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
                      Gate & Rule Exclusion Breakdown
                    </h4>
                    {Object.keys(dryRun.reasonBreakdown || {}).length === 0 ? (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No customers excluded.</div>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                        {Object.entries(dryRun.reasonBreakdown).map(([reason, count]) => (
                          <div
                            key={reason}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '6px 12px',
                              borderRadius: 20,
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: '1px solid var(--border-color)',
                              fontSize: '0.8rem',
                            }}
                          >
                            <span style={{ color: 'var(--accent-rose)', fontWeight: 700 }}>{count}</span>
                            <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Sample Recipient Plans with WhatsApp Message Render */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff' }}>
                        Sample Recipient Plans ({dryRun.samplePlans.length})
                      </h4>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        First local send time vs UTC instant shown per recipient (e.g. 10:00 IST = 04:30 UTC)
                      </span>
                    </div>

                    {dryRun.samplePlans.length === 0 ? (
                      <div className="glass-panel" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                        No eligible sample recipients found for this draft criteria.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {dryRun.samplePlans.map((plan, pIdx) => {
                          const isExpanded = expandedPlanIndex === pIdx;
                          return (
                            <div
                              key={pIdx}
                              className="glass-panel"
                              style={{
                                border: isExpanded ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid var(--border-color)',
                                overflow: 'hidden',
                              }}
                            >
                              {/* Summary row */}
                              <div
                                onClick={() => setExpandedPlanIndex(isExpanded ? null : pIdx)}
                                style={{
                                  padding: '14px 18px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  cursor: 'pointer',
                                  background: isExpanded ? 'rgba(99, 102, 241, 0.06)' : 'transparent',
                                  gap: 16,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                  {isExpanded ? (
                                    <ChevronDown size={18} color="var(--accent-indigo)" />
                                  ) : (
                                    <ChevronRight size={18} color="var(--text-muted)" />
                                  )}
                                  <div>
                                    <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                                      {plan.customerName}
                                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                        ({plan.maskedPhone})
                                      </span>
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--accent-emerald)', marginTop: 2 }}>
                                      {plan.matchExplanation}
                                    </div>
                                  </div>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                                  <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontSize: '0.8rem', color: '#fff', fontWeight: 600 }}>
                                      {plan.firstLocalDate}
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                                      {new Date(plan.firstDueAtUtc).toISOString().replace('.000Z', 'Z')}
                                    </div>
                                  </div>
                                  <span className="badge badge-indigo" style={{ fontSize: '0.7rem' }}>
                                    {plan.occurrenceId}
                                  </span>
                                </div>
                              </div>

                              {/* Expanded details */}
                              {isExpanded && (
                                <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 16 }}>
                                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                    <strong>Recipient ID:</strong> {plan.customerId} &bull; <strong>Occasion Date:</strong> {plan.occasionLocalDate}
                                  </div>

                                  {/* Planned Steps */}
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    {plan.steps.map((st, sIdx) => (
                                      <div
                                        key={sIdx}
                                        style={{
                                          padding: 14,
                                          borderRadius: 8,
                                          background: 'rgba(0, 0, 0, 0.25)',
                                          border: '1px solid var(--border-color)',
                                          display: 'flex',
                                          flexDirection: 'column',
                                          gap: 10,
                                        }}
                                      >
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span className={`badge ${st.status === 'SCHEDULED' ? 'badge-emerald' : 'badge-amber'}`}>
                                              {st.status}
                                            </span>
                                            <span style={{ fontWeight: 600, color: '#fff', fontSize: '0.85rem' }}>
                                              Step {sIdx + 1}: {st.stepName} ({st.stepId})
                                            </span>
                                          </div>

                                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                            <span>Local: <strong style={{ color: '#fff' }}>{st.localDate} {st.localTime}</strong></span>
                                            <span>UTC: <strong style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>{new Date(st.dueAtUtc).toISOString().replace('.000Z', 'Z')}</strong></span>
                                            <span>Expires: <strong style={{ color: 'var(--accent-amber)', fontFamily: 'var(--font-mono)' }}>{new Date(st.expiresAtUtc).toISOString().replace('.000Z', 'Z')}</strong></span>
                                          </div>
                                        </div>

                                        {/* Rendered WhatsApp Message Box */}
                                        <div
                                          style={{
                                            padding: '12px 16px',
                                            borderRadius: 8,
                                            background: 'rgba(16, 185, 129, 0.06)',
                                            border: '1px solid rgba(16, 185, 129, 0.25)',
                                          }}
                                        >
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                                            <span style={{ fontSize: '0.7rem', color: 'var(--accent-emerald)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                              Rendered WhatsApp Message Preview
                                            </span>
                                            {st.skipReason && (
                                              <span className="badge badge-amber" style={{ fontSize: '0.65rem' }}>
                                                {st.skipReason}
                                              </span>
                                            )}
                                          </div>
                                          <p style={{ color: '#ecfdf5', fontSize: '0.85rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0 }}>
                                            {st.renderedMessage}
                                          </p>
                                          <div style={{ marginTop: 8, fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                            Template: {st.templateName} &bull; ID: {st.templateId}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Excluded Samples List */}
                  {dryRun.excludedSamples && dryRun.excludedSamples.length > 0 && (
                    <div className="glass-panel" style={{ padding: 18 }}>
                      <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
                        Excluded Customers Sample ({dryRun.excludedSamples.length})
                      </h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {dryRun.excludedSamples.map((ex, exIdx) => (
                          <div
                            key={exIdx}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 12px',
                              borderRadius: 6,
                              background: 'rgba(255, 255, 255, 0.03)',
                              border: '1px solid var(--border-color)',
                              fontSize: '0.8rem',
                              gap: 12,
                              flexWrap: 'wrap',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontWeight: 600, color: '#fff' }}>{ex.customerName}</span>
                              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>({ex.customerId})</span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: 'rgba(244, 63, 94, 0.15)',
                                  color: 'var(--accent-rose)',
                                  border: '1px solid rgba(244, 63, 94, 0.3)',
                                  fontFamily: 'var(--font-mono)',
                                }}
                              >
                                {ex.primaryReason}
                              </span>
                              {ex.details && (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                  {ex.details}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Feature F24: Test with an Order Preview Panel (Spec p19, p28) */}
              {(draft.trigger.type === 'ORDER_EVENT_DELAY' || (draft.trigger as any)?.anchor === 'ORDER_COMPLETED_AT') && (
                <div
                  className="glass-panel"
                  style={{
                    padding: 24,
                    border: '1px solid rgba(139, 92, 246, 0.4)',
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.05) 0%, rgba(236, 72, 153, 0.03) 100%)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          background: 'rgba(139, 92, 246, 0.15)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#c084fc',
                        }}
                      >
                        <Sparkles size={18} />
                      </div>
                      <div>
                        <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                          Test with an Order &bull; Live Outfit Matching Preview
                        </h4>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                          Simulate late-binding resolver and complement matching for any existing qualifying order (Spec p19, p28).
                        </div>
                      </div>
                    </div>
                    <span
                      style={{
                        padding: '4px 10px',
                        borderRadius: 20,
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        background: 'rgba(139, 92, 246, 0.15)',
                        color: '#c084fc',
                        border: '1px solid rgba(139, 92, 246, 0.3)',
                      }}
                    >
                      F24 Outfit Simulator
                    </span>
                  </div>

                  {/* Input and button */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                        Qualifying Order ID to Test
                      </label>
                      <input
                        id="input-outfit-test-order-id"
                        type="text"
                        value={outfitPreviewOrderId}
                        onChange={(e) => setOutfitPreviewOrderId(e.target.value)}
                        placeholder="e.g. order_saree_01"
                        className="input-field"
                        style={{ width: '100%', fontSize: '0.85rem' }}
                      />
                    </div>
                    <div style={{ alignSelf: 'flex-end' }}>
                      <button
                        id="btn-run-outfit-preview"
                        type="button"
                        onClick={runOutfitPreview}
                        disabled={outfitPreviewLoading || !outfitPreviewOrderId.trim()}
                        className="btn btn-primary"
                        style={{ background: 'linear-gradient(135deg, #7c3aed, #a855f7)', fontSize: '0.85rem', padding: '9px 18px' }}
                      >
                        {outfitPreviewLoading ? 'Evaluating Match...' : 'Simulate Outfit Match'}
                      </button>
                    </div>
                  </div>

                  {/* Error state */}
                  {outfitPreviewError && (
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 6,
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: 'var(--accent-rose)',
                        fontSize: '0.85rem',
                      }}
                    >
                      {outfitPreviewError}
                    </div>
                  )}

                  {/* Results preview */}
                  {outfitPreviewData && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                          gap: 12,
                        }}
                      >
                        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)' }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Anchor Item</span>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginTop: 4 }}>
                            {outfitPreviewData.anchorItem?.itemName || 'Unknown Item'}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                            Category: {outfitPreviewData.anchorItem?.category || 'saree'} &bull; Colour: {outfitPreviewData.anchorItem?.colourFamily || 'any'} &bull; Weave: {outfitPreviewData.anchorItem?.weave || 'any'}
                          </div>
                        </div>

                        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)' }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Matching Outcome</span>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, marginTop: 4, color: outfitPreviewData.outcome === 'WILL_SEND' ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>
                            {outfitPreviewData.outcome}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                            {outfitPreviewData.matches?.length || 0} complement(s) selected
                          </div>
                        </div>
                      </div>

                      {/* Matched Complements */}
                      {outfitPreviewData.matches && outfitPreviewData.matches.length > 0 && (
                        <div>
                          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                            Selected Complements (Deterministic Priority Order):
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                            {outfitPreviewData.matches.map((m: any, mIdx: number) => (
                              <div
                                key={mIdx}
                                style={{
                                  padding: 12,
                                  borderRadius: 8,
                                  background: 'rgba(139, 92, 246, 0.08)',
                                  border: '1px solid rgba(139, 92, 246, 0.25)',
                                }}
                              >
                                <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>
                                  #{mIdx + 1} {m.name}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                                  Category: {m.category} &bull; Colour: {m.colourFamily} &bull; Weave: {m.weave}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: '#c084fc', marginTop: 4, fontWeight: 600 }}>
                                  ₹{((m.pricePaise || 0) / 100).toLocaleString('en-IN')} &bull; Score: {m.score} &bull; In Stock: {m.stockQty}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Live WhatsApp Message Bubble Preview */}
                      {outfitPreviewData.messagePreview && (
                        <div
                          style={{
                            background: 'linear-gradient(180deg, #0b141a 0%, #111b21 100%)',
                            border: '1px solid rgba(37, 211, 102, 0.2)',
                            borderRadius: 12,
                            padding: 14,
                            marginTop: 4,
                          }}
                        >
                          <div style={{ fontSize: '0.7rem', color: '#25d366', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>
                            Simulated WhatsApp Message Render
                          </div>
                          <div
                            style={{
                              background: '#005c4b',
                              borderRadius: '8px 8px 2px 8px',
                              padding: '10px 14px',
                              color: '#e9edef',
                              fontSize: '0.85rem',
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {outfitPreviewData.messagePreview}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* F26: Matching Collection Affinity Simulator */}
              {campaign && (campaign.presetId === 'matching_collection' || campaign.presetId === 'MATCHING_COLLECTION') && (
                <div
                  className="glass-panel"
                  style={{
                    padding: 24,
                    marginTop: 24,
                    border: '1px solid rgba(168, 85, 247, 0.35)',
                    background: 'rgba(168, 85, 247, 0.04)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                        Matching Collection Simulator
                      </h3>
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '4px 0 0' }}>
                        Simulate customer preference affinity scoring (40% weave, 30% colour, 20% size, 10% category) against a published collection release.
                      </p>
                    </div>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: 12,
                        background: 'rgba(168, 85, 247, 0.15)',
                        color: 'var(--accent-purple, #c084fc)',
                        border: '1px solid rgba(168, 85, 247, 0.3)',
                      }}
                    >
                      F26 Affinity Engine
                    </span>
                  </div>

                  {/* Input and button */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                        Collection Release ID to Test
                      </label>
                      <input
                        id="input-collection-test-release-id"
                        type="text"
                        value={collectionPreviewReleaseId}
                        onChange={(e) => setCollectionPreviewReleaseId(e.target.value)}
                        placeholder="e.g. rel_mc_winter"
                        className="input-field"
                        style={{ width: '100%', fontSize: '0.85rem' }}
                      />
                    </div>
                    <div style={{ alignSelf: 'flex-end' }}>
                      <button
                        id="btn-run-collection-preview"
                        type="button"
                        onClick={runCollectionPreview}
                        disabled={collectionPreviewLoading || !collectionPreviewReleaseId.trim()}
                        className="btn btn-primary"
                        style={{ background: 'linear-gradient(135deg, #9333ea, #c084fc)', fontSize: '0.85rem', padding: '9px 18px' }}
                      >
                        {collectionPreviewLoading ? 'Evaluating Affinity...' : 'Simulate Collection Match'}
                      </button>
                    </div>
                  </div>

                  {/* Error state */}
                  {collectionPreviewError && (
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 6,
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: 'var(--accent-rose)',
                        fontSize: '0.85rem',
                      }}
                    >
                      {collectionPreviewError}
                    </div>
                  )}

                  {/* Results Display */}
                  {collectionPreviewData && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                          gap: 12,
                        }}
                      >
                        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Collection Title</div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginTop: 2 }}>{collectionPreviewData.collectionTitle || collectionPreviewData.releaseId}</div>
                        </div>
                        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Eligible Matches</div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-emerald, #34d399)', marginTop: 2 }}>
                            {collectionPreviewData.eligibleCount} / {collectionPreviewData.sampledCount} sampled
                          </div>
                        </div>
                        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Min Affinity Score</div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-purple, #c084fc)', marginTop: 2 }}>
                            {((collectionPreviewData.minAffinityScore || 0) * 100).toFixed(0)}%
                          </div>
                        </div>
                      </div>

                      {/* Customer list */}
                      {collectionPreviewData.results && collectionPreviewData.results.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
                          {collectionPreviewData.results.map((r: any, rIdx: number) => (
                            <div
                              key={rIdx}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '8px 12px',
                                borderRadius: 6,
                                background: r.eligible ? 'rgba(52, 211, 153, 0.06)' : 'rgba(255, 255, 255, 0.02)',
                                border: r.eligible ? '1px solid rgba(52, 211, 153, 0.2)' : '1px solid rgba(255, 255, 255, 0.05)',
                                fontSize: '0.82rem',
                              }}
                            >
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontWeight: 600, color: '#fff' }}>{r.name || r.customerId}</span>
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{r.explanation}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                {r.bestMatchItem && (
                                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    Best: {r.bestMatchItem.name}
                                  </span>
                                )}
                                <span
                                  style={{
                                    fontWeight: 700,
                                    color: r.eligible ? 'var(--accent-emerald, #34d399)' : 'var(--text-muted)',
                                    background: r.eligible ? 'rgba(52, 211, 153, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                                    padding: '2px 8px',
                                    borderRadius: 10,
                                  }}
                                >
                                  {(r.score * 100).toFixed(0)}%
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* F27: Selected-stock offer review */}
              {campaign && (campaign.presetId === 'selected_stock_promotion' || campaign.presetId === 'SELECTED_STOCK_PROMOTION') && (
                <div className="glass-panel" style={{ padding: 24, marginTop: 24, border: '1px solid rgba(245, 158, 11, 0.35)', background: 'rgba(245, 158, 11, 0.04)' }}>
                  <h3 style={{ margin: 0, color: '#fff', fontSize: '1.05rem' }}>Selected-stock offer review</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.5 }}>
                    Offers, prices, products, stock and preferences come from other systems. This campaign never creates or applies a discount; values are re-read when a message is sent.
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <input className="input-field" value={stockOfferId} onChange={(event) => setStockOfferId(event.target.value)} aria-label="Offer ID" placeholder="off_sp_percent" />
                    <button type="button" className="btn btn-primary" onClick={runStockPreview}>Test an offer</button>
                  </div>
                  {stockPreviewError && <p style={{ color: 'var(--accent-rose)', fontSize: '0.82rem' }}>{stockPreviewError}</p>}
                  {stockPreview && (
                    <div style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      <strong style={{ color: '#fff' }}>{stockPreview.offer?.name || stockOfferId}</strong>
                      <span style={{ marginLeft: 12 }}>Status: {stockPreview.offer?.status}</span>
                      <span style={{ marginLeft: 12 }}>Matched: {stockPreview.matched} / {stockPreview.scanned}</span>
                      <span style={{ marginLeft: 12 }}>Limit: {stockPreview.limit}</span>
                    </div>
                  )}
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', marginBottom: 0 }}>
                    A message never reserves an item or claims low stock. Paused, ended, or unmatched offers are skipped at send time.
                  </p>
                </div>
              )}

              {/* F28: Festival collection season review */}
              {campaign && (campaign.presetId === 'festival_collection' || campaign.presetId === 'FESTIVAL_COLLECTION' || campaign.presetId === 'festival') && (
                <div className="glass-panel" style={{ padding: 24, marginTop: 24, border: '1px solid rgba(236, 72, 153, 0.35)', background: 'rgba(236, 72, 153, 0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <Sparkles size={18} color="#ec4899" />
                    <h3 style={{ margin: 0, color: '#fff', fontSize: '1.05rem', fontWeight: 700 }}>Festival Season Collection Review (F28)</h3>
                  </div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.5 }}>
                    Festival dates, seasons, and catalogue collections come from your catalogue and season calendar. Customers are matched strictly on declared saree/outfit preferences (Hard Rule 8: names and religion are never inferred).
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <input className="input-field" value={festivalSeasonId} onChange={(event) => setFestivalSeasonId(event.target.value)} aria-label="Season ID" placeholder="season_fc_diwali" style={{ minWidth: 220 }} />
                    <button type="button" className="btn btn-primary" onClick={runFestivalPreview} disabled={festivalPreviewLoading}>
                      {festivalPreviewLoading ? 'Evaluating...' : 'Test Season Matching'}
                    </button>
                  </div>
                  {festivalPreviewError && <p style={{ color: 'var(--accent-rose)', fontSize: '0.82rem', marginTop: 8 }}>{festivalPreviewError}</p>}
                  {festivalPreview && (
                    <div style={{ marginTop: 14, padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.07)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <strong style={{ color: '#fff', fontSize: '0.92rem' }}>{festivalPreview.season?.name || festivalSeasonId}</strong>
                        <span className="badge badge-ACTIVE">{festivalPreview.season?.status || 'ACTIVE'}</span>
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 16, color: 'var(--text-secondary)', fontSize: '0.82rem', flexWrap: 'wrap' }}>
                        <span>Festival Date: {festivalPreview.season?.festivalDate ? new Date(festivalPreview.season.festivalDate).toLocaleDateString() : 'N/A'}</span>
                        <span>Matched Audience: <strong>{festivalPreview.wouldCount}</strong> / {festivalPreview.scanned} customers</span>
                        <span>Collection Items: {festivalPreview.items?.length || 0}</span>
                      </div>
                      {festivalPreview.samples && festivalPreview.samples.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Sample Matches</span>
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {festivalPreview.samples.slice(0, 3).map((sample: any, idx: number) => (
                              <div key={idx} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', gap: 8 }}>
                                <span style={{ color: 'var(--accent-cyan)' }}>{sample.customerRef}</span>
                                <span>{sample.matched ? `Matched: ${sample.items?.map((it: any) => it.name).join(', ') || 'Festival items'}` : 'Not matched'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', marginTop: 12, marginBottom: 0 }}>
                    Step 1 launches D-21 prior to the festival; Step 2 follows up at D-7. Steps past the festival date automatically expire.
                  </p>
                </div>
              )}

              {/* F29: Exhibition / Trunk Show review */}
              {campaign && (campaign.presetId === 'exhibition_trunk_show' || campaign.presetId === 'EXHIBITION_TRUNK_SHOW' || campaign.presetId === 'exhibition' || campaign.presetId === 'trunk_show' || campaign.presetId === 'store_event') && (
                <div className="glass-panel" style={{ padding: 18, marginTop: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <Calendar size={18} color="var(--accent-indigo)" />
                    <h3 style={{ margin: 0, color: '#fff', fontSize: '1.05rem', fontWeight: 700 }}>Exhibition / Trunk Show Review (F29)</h3>
                  </div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.5 }}>
                    Authoritative trunk shows, exhibitions, and pop-ups are event-driven. Customers are matched strictly based on geography, venue capacity, and declared categories (Hard Rule 8: names and religion are never inferred).
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <input className="input-field" value={exhibitionEventId} onChange={(event) => setExhibitionEventId(event.target.value)} aria-label="Event ID" placeholder="evt_ex_mumbai_2026" style={{ minWidth: 220 }} />
                    <button type="button" className="btn btn-primary" onClick={runExhibitionPreview} disabled={exhibitionPreviewLoading}>
                      {exhibitionPreviewLoading ? 'Evaluating...' : 'Test Event Matching'}
                    </button>
                  </div>
                  {exhibitionPreviewError && <p style={{ color: 'var(--accent-rose)', fontSize: '0.82rem', marginTop: 8 }}>{exhibitionPreviewError}</p>}
                  {exhibitionPreview && (
                    <div style={{ marginTop: 14, padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.07)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <strong style={{ color: '#fff', fontSize: '0.92rem' }}>{exhibitionPreview.event?.title || exhibitionEventId}</strong>
                        <span className="badge badge-ACTIVE">{exhibitionPreview.event?.status || 'ACTIVE'}</span>
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 16, color: 'var(--text-secondary)', fontSize: '0.82rem', flexWrap: 'wrap' }}>
                        <span>Start Date: {exhibitionPreview.event?.startDate ? new Date(exhibitionPreview.event.startDate).toLocaleDateString() : 'N/A'}</span>
                        <span>Venue: {exhibitionPreview.event?.venue?.name || 'N/A'}, {exhibitionPreview.event?.city || ''}</span>
                        <span>Capacity: {exhibitionPreview.event?.registeredCount ?? 0} / {exhibitionPreview.event?.capacity || 'Open'}</span>
                        <span>Matched Audience: <strong>{exhibitionPreview.wouldCount}</strong> / {exhibitionPreview.scanned} customers</span>
                      </div>
                      {exhibitionPreview.samples && exhibitionPreview.samples.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Sample Matches</span>
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {exhibitionPreview.samples.slice(0, 3).map((sample: any, idx: number) => (
                              <div key={idx} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', gap: 8 }}>
                                <span style={{ color: 'var(--accent-cyan)' }}>{sample.customerRef}</span>
                                <span>{sample.matched ? `Matched: ${sample.matchReasons?.join(', ') || 'Eligible customer'}` : `Excluded: ${sample.reason || 'Not matched'}`}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', marginTop: 12, marginBottom: 0 }}>
                    Step 1 Invitation launches D-14 prior to the event; Step 2 Reminder follows up at D-3. Steps past the event start date automatically skip with EVENT_ENDED.
                  </p>
                </div>
              )}

              {/* F30: Fitting / Alteration Review */}
              {campaign && (campaign.presetId === 'fitting_alteration' || campaign.presetId === 'FITTING_ALTERATION' || campaign.presetId === 'fitting' || campaign.presetId === 'alteration' || campaign.presetId === 'fitting_appointment' || campaign.presetId === 'alteration_milestone') && (
                <div className="glass-panel" style={{ padding: 18, marginTop: 16, border: '1px solid rgba(20, 184, 166, 0.35)', background: 'rgba(20, 184, 166, 0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <Scissors size={18} color="#14b8a6" />
                    <h3 style={{ margin: 0, color: '#fff', fontSize: '1.05rem', fontWeight: 700 }}>Fitting / Alteration Review (F30)</h3>
                    <span className="badge badge-ACTIVE" style={{ fontSize: '0.7rem' }}>SERVICE CATEGORY</span>
                  </div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.5, marginBottom: 12 }}>
                    Fitting and Alteration is a unified <strong>SERVICE</strong> preset family covering two distinct sequence modes:
                    <strong> Fitting Appointments</strong> (confirmation + 24h reminder before trial; rescheduling recalculates reminder to 24h before new time per QA Matrix A17) and
                    <strong> Tailoring Milestones</strong> (stage-specific tailoring progress; strictly avoids over-promising that the whole outfit is ready when only a stage or blouse is complete).
                    Operates under service purpose: does not consume marketing contact caps and strictly forbids promotional offers or discounts.
                  </p>

                  <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                    <button
                      type="button"
                      className={`btn ${faPreviewType === 'appointment' ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ padding: '4px 12px', fontSize: '0.78rem' }}
                      onClick={() => setFaPreviewType('appointment')}
                    >
                      Fitting Appointment Flow
                    </button>
                    <button
                      type="button"
                      className={`btn ${faPreviewType === 'alteration' ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ padding: '4px 12px', fontSize: '0.78rem' }}
                      onClick={() => setFaPreviewType('alteration')}
                    >
                      Alteration Milestone Flow
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {faPreviewType === 'appointment' ? (
                      <input
                        className="input-field"
                        value={faAppointmentId}
                        onChange={(event) => setFaAppointmentId(event.target.value)}
                        aria-label="Appointment ID"
                        placeholder="appt_fa_01"
                        style={{ minWidth: 220 }}
                      />
                    ) : (
                      <input
                        className="input-field"
                        value={faJobId}
                        onChange={(event) => setFaJobId(event.target.value)}
                        aria-label="Job ID"
                        placeholder="alt_fa_01"
                        style={{ minWidth: 220 }}
                      />
                    )}
                    <button type="button" className="btn btn-primary" onClick={runFaPreview} disabled={faPreviewLoading}>
                      {faPreviewLoading ? 'Evaluating...' : faPreviewType === 'appointment' ? 'Test Appointment Matching' : 'Test Alteration Matching'}
                    </button>
                  </div>

                  {faPreviewError && <p style={{ color: 'var(--accent-rose)', fontSize: '0.82rem', marginTop: 8 }}>{faPreviewError}</p>}
                  {faPreview && (
                    <div style={{ marginTop: 14, padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.07)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <strong style={{ color: '#fff', fontSize: '0.92rem' }}>
                          {faPreview.type === 'APPOINTMENT'
                            ? `Appointment: ${faPreview.appointment?.appointmentId} (${faPreview.appointment?.serviceType})`
                            : `Alteration Job: ${faPreview.alteration?.jobId} (${faPreview.alteration?.garmentDescription})`}
                        </strong>
                        <span className={`badge ${faPreview.match?.eligible ? 'badge-ACTIVE' : 'badge-PAUSED'}`}>
                          {faPreview.match?.eligible ? 'ELIGIBLE' : faPreview.match?.reason || 'EXCLUDED'}
                        </span>
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 16, color: 'var(--text-secondary)', fontSize: '0.82rem', flexWrap: 'wrap' }}>
                        <span>Customer: <strong>{faPreview.customer?.firstName || 'Customer'}</strong> ({faPreview.customer?.customerId})</span>
                        {faPreview.type === 'APPOINTMENT' ? (
                          <>
                            <span>Scheduled: {faPreview.appointment?.scheduledAt ? new Date(faPreview.appointment.scheduledAt).toLocaleString() : 'N/A'}</span>
                            <span>Stylist: {faPreview.appointment?.stylistName || 'Store Staff'}</span>
                            <span>Status: {faPreview.appointment?.status}</span>
                          </>
                        ) : (
                          <>
                            <span>Stage: {faPreview.alteration?.currentStage}</span>
                            <span>Trial Date: {faPreview.alteration?.trialDate ? new Date(faPreview.alteration.trialDate).toLocaleDateString() : 'Pending'}</span>
                            <span>Notes: {faPreview.alteration?.notes || 'None'}</span>
                          </>
                        )}
                      </div>
                      {faPreview.match?.reasonText && (
                        <div style={{ marginTop: 8, fontSize: '0.78rem', color: faPreview.match?.eligible ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
                          {faPreview.match.reasonText}
                        </div>
                      )}
                    </div>
                  )}

                  <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', marginTop: 12, marginBottom: 0 }}>
                    Step 1 Confirmation sends immediately on booking. Step 2 Reminder delivers 24h prior to appointment. On rescheduling, reminder dueAt automatically shifts and bumps planRevision.
                  </p>
                </div>
              )}

              {/* Feature 7: Campaign Activation & Revision Card (Spec p9, p20, p25) */}
              <div
                className="glass-panel"
                style={{
                  padding: 24,
                  marginTop: 24,
                  border: isRevision
                    ? '1px solid rgba(6, 182, 212, 0.4)'
                    : '1px solid rgba(16, 185, 129, 0.4)',
                  background: isRevision
                    ? 'rgba(6, 182, 212, 0.04)'
                    : 'rgba(16, 185, 129, 0.04)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 10,
                        background: isRevision ? 'rgba(6, 182, 212, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                        border: isRevision ? '1px solid rgba(6, 182, 212, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isRevision ? <Sparkles size={22} color="var(--accent-cyan)" /> : <Play size={22} color="var(--accent-emerald)" />}
                    </div>
                    <div>
                      <h4 style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                        {isRevision ? `Publish Revision v${draft.version}` : 'Activate Auto Campaign'}
                      </h4>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>
                        {isRevision
                          ? 'Publish this draft as a new immutable version. Existing enrollments remain pinned to version N (Spec p9, B14).'
                          : 'Freezes an immutable campaign version snapshot. Schedules autonomous evaluation during sending hours (Spec p9, p20).'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setActivationError(null);
                      setConfirmModalOpen(true);
                    }}
                    disabled={!dryRun || dryRun.isStale || (validationReport !== null && !validationReport.valid) || activating}
                    className="btn btn-primary"
                    style={{
                      padding: '10px 24px',
                      background: isRevision ? 'var(--accent-cyan)' : 'var(--accent-emerald)',
                      borderColor: isRevision ? 'var(--accent-cyan)' : 'var(--accent-emerald)',
                      color: '#000',
                      fontWeight: 800,
                      fontSize: '0.9rem',
                    }}
                  >
                    {isRevision ? (
                      <>
                        <Sparkles size={16} />
                        Publish Revision v{draft.version}
                      </>
                    ) : (
                      <>
                        <Play size={16} />
                        Activate Campaign
                      </>
                    )}
                  </button>
                </div>

                {/* Readiness status checks */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, fontSize: '0.8rem' }}>
                  <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {validationReport?.valid ? <CheckCircle2 size={16} color="var(--accent-emerald)" /> : <AlertTriangle size={16} color="var(--accent-amber)" />}
                    <span>{validationReport?.valid ? 'Draft Validation: Passed' : 'Draft Validation: Pending or Failed'}</span>
                  </div>

                  <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {dryRun && !dryRun.isStale ? <CheckCircle2 size={16} color="var(--accent-emerald)" /> : <AlertTriangle size={16} color="var(--accent-amber)" />}
                    <span>{dryRun && !dryRun.isStale ? `Dry Run: Verified (${dryRun.counts.eligible} eligible)` : dryRun?.isStale ? 'Dry Run: Stale (draft modified)' : 'Dry Run: Required'}</span>
                  </div>

                  <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Lock size={16} color="var(--accent-cyan)" />
                    <span>Immutability: Version v{draft.version} will be frozen</span>
                  </div>
                </div>

                {/* Zero matches warning (A04) */}
                {dryRun && !dryRun.isStale && dryRun.counts.eligible === 0 && (
                  <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.8rem', color: '#fde68a' }}>
                    <AlertTriangle size={18} color="var(--accent-amber)" style={{ flexShrink: 0 }} />
                    <span><strong>A04 Notice:</strong> Zero customers currently match today. Campaign will activate normally; the autonomous engine will evaluate new birthdays/occasions automatically.</span>
                  </div>
                )}

                {/* Dummy template warning */}
                {dummyTemplateInDraft && (
                  <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.8rem', color: '#fde68a' }}>
                    <AlertTriangle size={18} color="var(--accent-amber)" style={{ flexShrink: 0 }} />
                    <span><strong>Template Notice:</strong> A step uses dummy template &ldquo;{dummyTemplateInDraft.name}&rdquo; (sendable=false). In dry mode, activation is permitted with: <em>dry mode: this campaign cannot send real messages</em>. In meta mode, activation is blocked.</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Wizard Footer Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            type="button"
            disabled={activeStep <= 1}
            onClick={() => setActiveStep((prev) => Math.max(1, prev - 1))}
            className="btn btn-secondary"
            style={{ padding: '8px 16px' }}
          >
            <ArrowLeft size={16} />
            Previous Step
          </button>

          <button
            type="button"
            disabled={activeStep >= 5}
            onClick={() => setActiveStep((prev) => Math.min(5, prev + 1))}
            className="btn btn-primary"
            style={{ padding: '8px 20px' }}
          >
            Next Step
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
      )}

      {/* Suggestion Diff Modal */}
      {suggestionDiffModal && suggestionDiffModal.open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.78)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            style={{
              background: '#161922',
              borderRadius: 16,
              border: '1px solid rgba(255, 255, 255, 0.12)',
              width: '100%',
              maxWidth: 780,
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
              overflow: 'hidden',
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '20px 24px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    background: 'rgba(99, 102, 241, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#818cf8',
                  }}
                >
                  <Sparkles size={20} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: '#f3f4f6' }}>
                    Auto-Fill Variable Suggestions
                  </h3>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: '#9ca3af' }}>
                    {suggestionDiffModal.diffs.length} parameter differences found against catalogue recommendations
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSuggestionDiffModal(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#9ca3af',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body / Diff List */}
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#d1d5db', lineHeight: 1.5 }}>
                The following variables have different sources, literals, or fallbacks compared to the recommended defaults. Applying will update the draft step bindings in memory.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {suggestionDiffModal.diffs.map((d, i) => (
                  <div
                    key={i}
                    style={{
                      borderRadius: 10,
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      padding: '12px 16px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e5e7eb' }}>
                        Step {d.stepIndex + 1}: {d.stepName}
                      </span>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontFamily: 'monospace',
                          padding: '2px 8px',
                          borderRadius: 6,
                          background: 'rgba(99, 102, 241, 0.15)',
                          color: '#a5b4fc',
                        }}
                      >
                        {`{{${d.variableIndex}}}`} {d.variableName}
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: '0.8rem' }}>
                      {/* Current */}
                      <div
                        style={{
                          padding: '8px 12px',
                          borderRadius: 8,
                          background: 'rgba(239, 68, 68, 0.08)',
                          border: '1px solid rgba(239, 68, 68, 0.2)',
                        }}
                      >
                        <div style={{ fontSize: '0.7rem', color: '#f87171', fontWeight: 600, marginBottom: 4 }}>
                          CURRENT
                        </div>
                        <div style={{ color: '#fca5a5', fontFamily: 'monospace' }}>
                          source: {d.currentSource}
                          {d.currentLiteral ? ` = "${d.currentLiteral}"` : ''}
                          {d.currentFallback ? ` (fallback: "${d.currentFallback}")` : ''}
                        </div>
                      </div>

                      {/* Suggested */}
                      <div
                        style={{
                          padding: '8px 12px',
                          borderRadius: 8,
                          background: 'rgba(16, 185, 129, 0.08)',
                          border: '1px solid rgba(16, 185, 129, 0.2)',
                        }}
                      >
                        <div style={{ fontSize: '0.7rem', color: '#34d399', fontWeight: 600, marginBottom: 4 }}>
                          RECOMMENDED
                        </div>
                        <div style={{ color: '#6ee7b7', fontFamily: 'monospace' }}>
                          source: {d.suggestedSource}
                          {d.suggestedLiteral ? ` = "${d.suggestedLiteral}"` : ''}
                          {d.suggestedFallback ? ` (fallback: "${d.suggestedFallback}")` : ''}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: '16px 24px',
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 12,
                background: 'rgba(0, 0, 0, 0.2)',
              }}
            >
              <button
                type="button"
                onClick={() => setSuggestionDiffModal(null)}
                className="btn btn-secondary"
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                Keep Current Mappings
              </button>

              <button
                type="button"
                onClick={handleApplySuggestions}
                className="btn btn-primary"
                style={{ padding: '8px 20px', fontSize: '0.85rem' }}
              >
                <Sparkles size={16} />
                Apply {suggestionDiffModal.diffs.length} Suggestions
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Activation Modal */}
      <ActivationModal
        open={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        onConfirm={handleActivateOrPublish}
        activating={activating}
        campaign={campaign}
        draft={draft}
        dryRun={dryRun}
        isRevision={isRevision}
        error={activationError}
      />
    </AppShell>
  );
}

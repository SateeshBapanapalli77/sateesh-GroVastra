'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  Edit3,
  CheckCircle2,
  Clock,
  Lock,
  Layers,
  Sparkles,
  Calendar,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  AlertCircle,
  FileText,
  Users,
  Info,
  Activity,
  Search,
  Filter,
  RefreshCw,
  Play,
  X,
  Check,
  AlertTriangle,
  MessageCircle,
  Pause,
  Archive,
  Target,
  BarChart3,
} from 'lucide-react';
import { Campaign, CampaignVersion, CampaignStatus } from '@grovastra/shared';
import { useAuth } from '../context/AuthContext';
import { PauseModal, ResumeModal, ArchiveModal } from './CampaignLifecycleModals';
import { CampaignDashboardView } from './CampaignDashboardView';
import { CustomerTimelineModal } from './CustomerTimelineModal';

export interface CampaignDetailViewProps {
  campaign: Campaign;
  activeVersion: CampaignVersion | null;
  draft: CampaignVersion | null;
  versions: CampaignVersion[];
  initialTab?: 'dashboard' | 'overview' | 'activity';
  onEditCampaign: () => void;
  onBackToCampaigns: () => void;
  onCampaignUpdated?: () => void;
}

export interface EnrichedEnrollment {
  id?: string;
  enrollmentId: string;
  enrollmentKey: string;
  tenantId: string;
  campaignId: string;
  campaignVersionId: string;
  campaignVersion: number;
  customerId: string;
  customerName: string;
  maskedPhone: string;
  branchId?: string | null;
  occurrenceId: string;
  occasionLocalDate: string;
  planRevision: number;
  status: string;
  replyHoldAt?: string | null;
  replyAttribution?: string | null;
  replyContextMessageId?: string | null;
  lastReplyHoldAt?: string | null;
  holdResolvedAt?: string | null;
  holdResolvedBy?: string | null;
  holdResolutionCause?: string | null;
  goalReachedAt?: string | null;
  goalEventId?: string | null;
  goalOrderRef?: string | null;
  goalSource?: string | null;
  orderRef?: string | null;
  matchExplanation: string;
  totalSteps: number;
  scheduledStepsCount: number;
  stepsSummary?: Array<{
    stepId: string;
    stepName: string;
    state: string;
    providerStatus?: string | null;
  }>;
  nextStepName?: string | null;
  nextDueAt?: string | null;
  nextLocalDate?: string | null;
  nextLocalTime?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ExecutionStepItem {
  id?: string;
  executionId: string;
  stepId: string;
  stepName?: string;
  dueAt: string;
  originalDueAt: string;
  expiresAt: string;
  localDate: string;
  localTime: string;
  timezone: string;
  planRevision: number;
  state: string;
  skipReason?: string | null;
  prerequisite: string;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  failedAt?: string | null;
  statusHistory?: Array<{
    status: string;
    timestamp: string;
    providerMessageId?: string | null;
  }>;
  lastErrorCategory?: string | null;
  retryAt?: string | null;
  attemptCount?: number;
  attempts?: Array<{
    attemptId: string;
    attemptNumber: number;
    attemptedAt: string;
    state: string;
    providerMessageId?: string | null;
    errorCategory?: string | null;
    errorCode?: number | null;
    errorMessage?: string | null;
  }>;
  templateRef?: {
    id: string;
    revision: number;
    language: string;
  } | null;
  deliveryIntentId?: string | null;
  deliveryIntent?: {
    id?: string;
    deliveryIntentId: string;
    deliveryKey: string;
    recipientVersion: number;
    maskedRecipient: string;
    templateRef: {
      id: string;
      revision: number;
      language: string;
    };
    parameters: Record<string, string | number>;
    payloadHash: string;
    state: string;
    attemptId: string;
    providerMessageId?: string | null;
    lastErrorCategory?: string | null;
    retryAt?: string | null;
    attempts?: Array<{
      attemptId: string;
      attemptNumber: number;
      attemptedAt: string;
      state: string;
      providerMessageId?: string | null;
      errorCategory?: string | null;
      errorCode?: number | null;
      errorMessage?: string | null;
    }>;
    createdAt?: string;
  } | null;
}

export interface EnrollmentDetailModalData {
  enrollment: EnrichedEnrollment;
  executions: ExecutionStepItem[];
  customer?: {
    customerId: string;
    firstName: string;
    maskedPhone: string;
    branchId?: string;
    language?: string;
  } | null;
  goalEvents?: Array<{
    id?: string;
    goalEventId: string;
    source: string;
    orderRef?: string | null;
    cause?: string | null;
    supportingRecord?: string | null;
    recordedBy: string;
    at: string;
  }>;
}

export function CampaignDetailView({
  campaign,
  activeVersion,
  draft,
  versions,
  initialTab = 'dashboard',
  onEditCampaign,
  onBackToCampaigns,
  onCampaignUpdated,
}: CampaignDetailViewProps) {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'overview' | 'activity'>(initialTab);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(
    activeVersion?.version ?? versions[0]?.version ?? null
  );

  // Customer Timeline Modal State
  const [selectedTimelineCustomerId, setSelectedTimelineCustomerId] = useState<string | null>(null);

  // Lifecycle Modals State
  const [pauseModalOpen, setPauseModalOpen] = useState(false);
  const [resumeModalOpen, setResumeModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);

  // Activity & Enrollments State
  const [enrollments, setEnrollments] = useState<EnrichedEnrollment[]>([]);
  const [loadingEnrollments, setLoadingEnrollments] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [runningPlanner, setRunningPlanner] = useState(false);
  const [runningWorker, setRunningWorker] = useState(false);
  const [plannerMessage, setPlannerMessage] = useState<string | null>(null);

  // Selected Enrollment for Step Detail Inspector
  const [selectedEnrollmentData, setSelectedEnrollmentData] = useState<EnrollmentDetailModalData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const isDraftAhead = draft && activeVersion && draft.version > activeVersion.version;

  // Fetch Enrollments
  const fetchEnrollments = useCallback(async () => {
    try {
      setLoadingEnrollments(true);
      const url = `/api/campaigns/${campaign.campaignId}/enrollments?status=${statusFilter}&search=${encodeURIComponent(
        searchQuery
      )}&limit=50`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setEnrollments(data.enrollments || []);
        setTotalCount(data.total || 0);
      }
    } catch {
      // Graceful error handling
    } finally {
      setLoadingEnrollments(false);
    }
  }, [campaign.campaignId, statusFilter, searchQuery]);

  useEffect(() => {
    if (activeTab === 'activity') {
      fetchEnrollments();
    }
  }, [activeTab, fetchEnrollments]);

  // Run Planner Manually
  const handleRunPlanner = async () => {
    try {
      setRunningPlanner(true);
      setPlannerMessage(null);
      const res = await fetch(`/api/campaigns/${campaign.campaignId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (res.ok) {
        const result = await res.json();
        setPlannerMessage(
          `Planner cycle completed: ${result.enrolledCount ?? 0} customer(s) enrolled, ${
            result.createdExecutionsCount ?? 0
          } step execution(s) planned.`
        );
        fetchEnrollments();
      } else {
        const err = await res.json();
        setPlannerMessage(err?.error?.message || 'Failed to run planner');
      }
    } catch {
      setPlannerMessage('Network error triggering planner');
    } finally {
      setRunningPlanner(false);
    }
  };

  // Run Worker Manually (Spec p19, p25)
  const handleRunWorker = async () => {
    try {
      setRunningWorker(true);
      setPlannerMessage(null);
      const res = await fetch(`/api/campaigns/${campaign.campaignId}/execute-due`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchSize: 50 }),
      });
      if (res.ok) {
        const result = await res.json();
        setPlannerMessage(
          `Worker evaluation cycle completed: ${result.claimedCount ?? 0} claimed, ${
            result.dispatchedCount ?? 0
          } intent(s) frozen/dispatched, ${result.skippedCount ?? 0} skipped, ${
            result.cancelledCount ?? 0
          } cancelled, ${result.blockedCount ?? 0} blocked, ${result.deferredCount ?? 0} deferred.`
        );
        fetchEnrollments();
      } else {
        const err = await res.json();
        setPlannerMessage(err?.error?.message || 'Failed to run worker');
      }
    } catch {
      setPlannerMessage('Network error triggering worker');
    } finally {
      setRunningWorker(false);
    }
  };

  // User Role & Permissions (Spec p26)
  const { user } = useAuth();
  const canResolveHold = user?.role === 'owner' || user?.role === 'admin' || user?.role === 'staff';
  const canMarkGoal = user?.role === 'owner' || user?.role === 'admin';

  // Action Modals State
  const [resolveHoldModalOpen, setResolveHoldModalOpen] = useState(false);
  const [resolveHoldCause, setResolveHoldCause] = useState('');
  const [resolveHoldSupporting, setResolveHoldSupporting] = useState('');
  const [submittingResolveHold, setSubmittingResolveHold] = useState(false);
  const [resolveHoldError, setResolveHoldError] = useState<string | null>(null);

  const [markGoalModalOpen, setMarkGoalModalOpen] = useState(false);
  const [markGoalCause, setMarkGoalCause] = useState('');
  const [markGoalOrderRef, setMarkGoalOrderRef] = useState('');
  const [markGoalSupporting, setMarkGoalSupporting] = useState('');
  const [submittingMarkGoal, setSubmittingMarkGoal] = useState(false);
  const [markGoalError, setMarkGoalError] = useState<string | null>(null);

  // Inspect Enrollment Steps
  const handleInspectEnrollment = async (enrollmentId: string) => {
    try {
      setLoadingDetail(true);
      const res = await fetch(`/api/campaigns/${campaign.campaignId}/enrollments/${enrollmentId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedEnrollmentData({
          enrollment: data.enrollment,
          executions: data.executions || [],
          customer: data.customer,
          goalEvents: data.goalEvents || [],
        });
      }
    } catch {
      // Graceful error handling
    } finally {
      setLoadingDetail(false);
    }
  };

  // Submit Resolve Hold
  const handleResolveHoldSubmit = async () => {
    if (!selectedEnrollmentData) return;
    if (!resolveHoldCause.trim()) {
      setResolveHoldError('Cause or reason is required to resolve hold');
      return;
    }
    try {
      setSubmittingResolveHold(true);
      setResolveHoldError(null);
      const res = await fetch(`/api/enrollments/${selectedEnrollmentData.enrollment.enrollmentId}/resolve-hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cause: resolveHoldCause.trim(),
          supportingRecord: resolveHoldSupporting.trim() || undefined,
        }),
      });
      if (res.ok) {
        setResolveHoldModalOpen(false);
        setResolveHoldCause('');
        setResolveHoldSupporting('');
        await handleInspectEnrollment(selectedEnrollmentData.enrollment.enrollmentId);
        fetchEnrollments();
      } else {
        const errData = await res.json();
        setResolveHoldError(errData?.error?.message || 'Failed to resolve hold');
      }
    } catch {
      setResolveHoldError('Network error resolving hold');
    } finally {
      setSubmittingResolveHold(false);
    }
  };

  // Submit Mark Goal
  const handleMarkGoalSubmit = async () => {
    if (!selectedEnrollmentData) return;
    try {
      setSubmittingMarkGoal(true);
      setMarkGoalError(null);
      const res = await fetch(`/api/enrollments/${selectedEnrollmentData.enrollment.enrollmentId}/mark-goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cause: markGoalCause.trim() || undefined,
          orderRef: markGoalOrderRef.trim() || undefined,
          supportingRecord: markGoalSupporting.trim() || undefined,
        }),
      });
      if (res.ok) {
        setMarkGoalModalOpen(false);
        setMarkGoalCause('');
        setMarkGoalOrderRef('');
        setMarkGoalSupporting('');
        await handleInspectEnrollment(selectedEnrollmentData.enrollment.enrollmentId);
        fetchEnrollments();
      } else {
        const errData = await res.json();
        setMarkGoalError(errData?.error?.message || 'Failed to mark goal');
      }
    } catch {
      setMarkGoalError('Network error marking goal');
    } finally {
      setSubmittingMarkGoal(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1040, margin: '0 auto', width: '100%' }}>
      {/* Top Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            onClick={onBackToCampaigns}
            className="btn btn-secondary"
            style={{ padding: '8px 14px', fontSize: '0.85rem' }}
          >
            <ArrowLeft size={16} />
            Campaigns
          </button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', margin: 0 }}>
                {campaign.name}
              </h2>
              <span
                className={`badge ${
                  campaign.status === 'ACTIVE'
                    ? 'badge-emerald'
                    : campaign.status === 'PAUSED'
                    ? 'badge-amber'
                    : 'badge-indigo'
                }`}
              >
                {campaign.status}
              </span>
              {activeVersion && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    color: 'var(--accent-emerald)',
                    background: 'rgba(16, 185, 129, 0.1)',
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    fontWeight: 700,
                  }}
                >
                  Active: v{activeVersion.version}
                </span>
              )}
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {campaign.campaignId} &bull; Preset: {campaign.presetId}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {campaign.status === 'ACTIVE' && (
            <>
              <button
                onClick={() => setPauseModalOpen(true)}
                className="btn btn-secondary"
                style={{
                  padding: '8px 16px',
                  fontSize: '0.85rem',
                  borderColor: 'rgba(245, 158, 11, 0.4)',
                  color: '#fbbf24',
                  background: 'rgba(245, 158, 11, 0.1)',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Pause size={14} />
                Pause Campaign
              </button>
              <button
                onClick={() => setArchiveModalOpen(true)}
                className="btn btn-secondary"
                style={{
                  padding: '8px 16px',
                  fontSize: '0.85rem',
                  borderColor: 'rgba(244, 63, 94, 0.35)',
                  color: '#fda4af',
                  background: 'rgba(244, 63, 94, 0.08)',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Archive size={14} />
                Archive
              </button>
            </>
          )}

          {campaign.status === 'PAUSED' && (
            <>
              <button
                onClick={() => setResumeModalOpen(true)}
                className="btn btn-primary"
                style={{
                  padding: '8px 18px',
                  fontSize: '0.85rem',
                  background: 'linear-gradient(135deg, #059669, #10b981)',
                  borderColor: 'transparent',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  boxShadow: '0 4px 14px rgba(16, 185, 129, 0.25)',
                }}
              >
                <Play size={14} />
                Resume Campaign
              </button>
              <button
                onClick={() => setArchiveModalOpen(true)}
                className="btn btn-secondary"
                style={{
                  padding: '8px 16px',
                  fontSize: '0.85rem',
                  borderColor: 'rgba(244, 63, 94, 0.35)',
                  color: '#fda4af',
                  background: 'rgba(244, 63, 94, 0.08)',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Archive size={14} />
                Archive
              </button>
            </>
          )}

          {campaign.status === 'ARCHIVED' && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 8,
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: 'var(--accent-rose)',
                fontSize: '0.8rem',
                fontWeight: 700,
              }}
            >
              <Archive size={14} />
              Archived (Read-Only)
            </span>
          )}

          {campaign.status !== 'ARCHIVED' && (
            <button
              onClick={onEditCampaign}
              className="btn btn-primary"
              style={{
                padding: '8px 20px',
                fontSize: '0.875rem',
                background: 'linear-gradient(135deg, var(--accent-indigo), var(--accent-cyan))',
                borderColor: 'transparent',
                fontWeight: 700,
              }}
            >
              <Edit3 size={15} />
              {isDraftAhead ? `Resume Draft v${draft.version}` : 'Edit Campaign'}
            </button>
          )}
        </div>
      </div>

      {/* View Mode Navigation Tabs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          paddingBottom: 4,
        }}
      >
        <button
          onClick={() => setActiveTab('dashboard')}
          style={{
            padding: '10px 18px',
            borderRadius: '8px 8px 0 0',
            fontSize: '0.875rem',
            fontWeight: 700,
            background: activeTab === 'dashboard' ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            color: activeTab === 'dashboard' ? '#fff' : 'var(--text-secondary)',
            borderBottom: activeTab === 'dashboard' ? '2px solid var(--accent-cyan)' : '2px solid transparent',
            borderTop: 'none',
            borderLeft: 'none',
            borderRight: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'all 0.2s',
          }}
        >
          <BarChart3 size={16} color={activeTab === 'dashboard' ? 'var(--accent-cyan)' : 'var(--text-muted)'} />
          Dashboard & Performance (Spec p28)
        </button>

        <button
          onClick={() => setActiveTab('activity')}
          style={{
            padding: '10px 18px',
            borderRadius: '8px 8px 0 0',
            fontSize: '0.875rem',
            fontWeight: 700,
            background: activeTab === 'activity' ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            color: activeTab === 'activity' ? '#fff' : 'var(--text-secondary)',
            borderBottom: activeTab === 'activity' ? '2px solid var(--accent-emerald)' : '2px solid transparent',
            borderTop: 'none',
            borderLeft: 'none',
            borderRight: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'all 0.2s',
          }}
        >
          <Activity size={16} color={activeTab === 'activity' ? 'var(--accent-emerald)' : 'var(--text-muted)'} />
          Campaign Activity & Enrollments (Spec p17, p26)
          {totalCount > 0 && (
            <span
              style={{
                fontSize: '0.7rem',
                padding: '2px 8px',
                borderRadius: 12,
                background: 'rgba(16, 185, 129, 0.2)',
                color: '#34d399',
                fontWeight: 700,
              }}
            >
              {totalCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('overview')}
          style={{
            padding: '10px 18px',
            borderRadius: '8px 8px 0 0',
            fontSize: '0.875rem',
            fontWeight: 700,
            background: activeTab === 'overview' ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            color: activeTab === 'overview' ? '#fff' : 'var(--text-secondary)',
            borderBottom: activeTab === 'overview' ? '2px solid var(--accent-indigo)' : '2px solid transparent',
            borderTop: 'none',
            borderLeft: 'none',
            borderRight: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'all 0.2s',
          }}
        >
          <Lock size={16} color={activeTab === 'overview' ? 'var(--accent-indigo)' : 'var(--text-muted)'} />
          Frozen Snapshot & Rules
        </button>
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: CAMPAIGN PERFORMANCE & ATTRIBUTION DASHBOARD */}
      {/* ==================================================================== */}
      {activeTab === 'dashboard' && (
        <CampaignDashboardView
          campaignId={campaign.campaignId}
          campaignName={campaign.name}
          presetId={campaign.presetId}
          status={campaign.status}
          onViewActivity={() => setActiveTab('activity')}
        />
      )}

      {/* ==================================================================== */}
      {/* TAB 2: OVERVIEW & FROZEN RULES SNAPSHOT */}
      {/* ==================================================================== */}
      {activeTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Edit Creates New Draft Banner (Spec p9, B14) */}
          <div
            className="glass-panel"
            style={{
              padding: '14px 18px',
              background: 'rgba(99, 102, 241, 0.08)',
              borderColor: 'rgba(99, 102, 241, 0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <Info size={22} color="var(--accent-cyan)" style={{ flexShrink: 0 }} />
            <div style={{ fontSize: '0.825rem', color: '#c7d2fe', lineHeight: 1.5 }}>
              <strong style={{ color: '#fff' }}>Immutable Versioning (Spec p9, B14):</strong> Editing this active campaign
              creates a new working draft (version v{(activeVersion?.version ?? 1) + 1}). The currently active version (v
              {activeVersion?.version}) continues running untouched for existing customer enrollments.
            </div>
          </div>

          {/* Active Version Overview Card */}
          {activeVersion ? (
            <div
              className="glass-panel"
              style={{
                padding: 24,
                borderLeft: '4px solid var(--accent-emerald)',
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: 'rgba(16, 185, 129, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Lock size={18} color="var(--accent-emerald)" />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                      Active Frozen Snapshot &bull; Version v{activeVersion.version}
                    </h3>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      Published and locked against updates. Autonomous calendar engine plans steps for eligible customers.
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-muted)',
                      background: 'rgba(255, 255, 255, 0.05)',
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    Fingerprint: {activeVersion.reviewFingerprint?.slice(0, 16) || 'N/A'}...
                  </span>
                </div>
              </div>

              {/* Next Evaluation Banner */}
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Clock size={18} color="var(--accent-emerald)" style={{ flexShrink: 0 }} />
                <div style={{ fontSize: '0.825rem', color: '#6ee7b7' }}>
                  <strong>Next Evaluation Schedule:</strong>{' '}
                  {activeVersion.nextEvaluationAt
                    ? new Date(activeVersion.nextEvaluationAt).toLocaleString('en-IN', {
                        timeZone: activeVersion.timezone || 'Asia/Kolkata',
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }) + ` (${activeVersion.timezone || 'Asia/Kolkata'})`
                    : 'Scheduled periodically every 15 minutes'}
                  . Autonomous evaluation is active; no manual sends required.
                </div>
              </div>

              {/* Steps Sequence Cards */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Layers size={16} color="var(--accent-cyan)" />
                  <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff' }}>
                    Scheduled Step Pipeline ({activeVersion.steps?.length || 0} Steps)
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
                  {(activeVersion.steps || []).map((step, idx) => (
                    <div
                      key={step.stepId}
                      style={{
                        padding: '16px 18px',
                        borderRadius: 10,
                        background: 'rgba(255, 255, 255, 0.03)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-indigo)' }}>
                          Step {idx + 1}
                        </span>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--accent-amber)',
                            background: 'rgba(245, 158, 11, 0.1)',
                            padding: '2px 8px',
                            borderRadius: 6,
                          }}
                        >
                          {step.delay
                            ? `+${step.delay.value} ${step.delay.unit.toLowerCase()} delay`
                            : (step.offsetDays ?? 0) === 0
                            ? 'Occasion Day'
                            : (step.offsetDays ?? 0) < 0
                            ? `D${step.offsetDays} (${Math.abs(step.offsetDays ?? 0)}d before)`
                            : `D+${step.offsetDays} (${step.offsetDays}d after)`}
                        </span>
                      </div>

                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff' }}>
                        {step.stepName || step.stepId}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        <div>
                          Local Time: <strong style={{ color: '#fff' }}>{step.localTime}</strong> ({activeVersion.timezone})
                        </div>
                        <div>
                          Template:{' '}
                          <code style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                            {step.templateRef?.id} (rev {step.templateRef?.revision})
                          </code>
                        </div>
                        <div>
                          Prerequisite: <strong style={{ color: '#fff' }}>{step.prerequisite}</strong>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="glass-panel" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
              No active version published yet.
            </div>
          )}

          {/* Version History List */}
          <div className="glass-panel" style={{ padding: 24 }}>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', marginBottom: 16 }}>
              Version History ({versions.length} versions)
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {versions.map((ver) => {
                const isExpanded = expandedVersion === ver.version;
                return (
                  <div
                    key={ver.version}
                    style={{
                      borderRadius: 10,
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      onClick={() => setExpandedVersion(isExpanded ? null : ver.version)}
                      style={{
                        padding: '12px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        <span style={{ fontWeight: 700, color: '#fff' }}>v{ver.version}</span>
                        {ver.isPublished ? (
                          <span className="badge badge-emerald">Published</span>
                        ) : (
                          <span className="badge badge-indigo">Draft</span>
                        )}
                        {activeVersion && activeVersion.version === ver.version && (
                          <span style={{ fontSize: '0.7rem', color: 'var(--accent-emerald)', fontWeight: 700 }}>
                            (Current Active)
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {ver.activatedAt ? new Date(ver.activatedAt).toLocaleDateString() : 'Unpublished draft'}
                      </span>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', background: 'rgba(0, 0, 0, 0.2)', fontSize: '0.8rem' }}>
                        <div><strong>Steps:</strong> {ver.steps?.length || 0} scheduled</div>
                        <div><strong>Fingerprint:</strong> <code>{ver.reviewFingerprint || 'None'}</code></div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: CAMPAIGN ACTIVITY & ENROLLMENTS */}
      {/* ==================================================================== */}
      {activeTab === 'activity' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Planner Feedback Banner */}
          {plannerMessage && (
            <div
              className="glass-panel"
              style={{
                padding: '12px 16px',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                color: '#34d399',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CheckCircle2 size={16} />
                <span>{plannerMessage}</span>
              </div>
              <button
                onClick={() => setPlannerMessage(null)}
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Action & Filter Toolbar */}
          <div
            className="glass-panel"
            style={{
              padding: '16px 20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {/* Search Box */}
              <div style={{ position: 'relative', minWidth: 260 }}>
                <Search
                  size={15}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="text"
                  placeholder="Search customer, phone, occurrence..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') fetchEnrollments();
                  }}
                  style={{
                    width: '100%',
                    padding: '8px 12px 8px 36px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    color: '#fff',
                    fontSize: '0.85rem',
                  }}
                />
              </div>

              {/* Status Filter Pills */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {(['ALL', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const).map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatusFilter(st)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 6,
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: statusFilter === st ? '1px solid var(--accent-indigo)' : '1px solid transparent',
                      background: statusFilter === st ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255, 255, 255, 0.03)',
                      color: statusFilter === st ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={fetchEnrollments}
                className="btn btn-secondary"
                disabled={loadingEnrollments}
                style={{ padding: '8px 12px', fontSize: '0.8rem' }}
                title="Refresh Enrollments"
              >
                <RefreshCw size={14} className={loadingEnrollments ? 'animate-spin' : ''} />
                Refresh
              </button>

              <button
                onClick={handleRunPlanner}
                className="btn btn-secondary"
                disabled={runningPlanner}
                style={{
                  padding: '8px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                }}
              >
                <Play size={14} className={runningPlanner ? 'animate-spin' : ''} />
                {runningPlanner
                  ? (campaign.presetId === 'win_back' ? 'Scanning Inactivity...' : 'Evaluating Horizon...')
                  : (campaign.presetId === 'win_back' ? 'Run Inactivity Scan' : 'Run Calendar Planner')}
              </button>

              <button
                onClick={handleRunWorker}
                className="btn btn-primary"
                disabled={runningWorker}
                style={{
                  padding: '8px 16px',
                  fontSize: '0.8rem',
                  background: 'linear-gradient(135deg, var(--accent-indigo), var(--accent-emerald))',
                  fontWeight: 700,
                }}
              >
                <RefreshCw size={14} className={runningWorker ? 'animate-spin' : ''} />
                {runningWorker ? 'Evaluating Due...' : 'Run Worker (Evaluate Due)'}
              </button>
            </div>
          </div>

          {/* Enrollments Table */}
          <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Users size={16} color="var(--accent-indigo)" />
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff' }}>
                  Enrolled Customers ({enrollments.length} shown of {totalCount})
                </span>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Each enrollment retains its PINNED version snapshot (Spec p17)
              </span>
            </div>

            {loadingEnrollments ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                <RefreshCw size={24} className="animate-spin" style={{ margin: '0 auto 12px' }} />
                Loading campaign enrollments...
              </div>
            ) : enrollments.length === 0 ? (
              <div style={{ padding: '48px 24px', textAlign: 'center' }}>
                <Calendar size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px', opacity: 0.5 }} />
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                  No Customer Enrollments Found
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', maxWidth: 480, margin: '0 auto 18px' }}>
                  {campaign.presetId === 'win_back'
                    ? 'Click \u201CRun Inactivity Scan\u201D above to discover customers whose last qualifying purchase passed the inactivity threshold.'
                    : 'Click \u201CRun Calendar Planner\u201D above to discover customers whose occasion falls within the planning horizon window.'}
                </p>
                <button
                  onClick={handleRunPlanner}
                  className="btn btn-secondary"
                  disabled={runningPlanner}
                  style={{ padding: '8px 18px', fontSize: '0.85rem' }}
                >
                  <Play size={14} className={runningPlanner ? 'animate-spin' : ''} />
                  {campaign.presetId === 'win_back' ? 'Run Inactivity Scan' : 'Run Planner Now'}
                </button>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255, 255, 255, 0.02)', borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
                      <th style={{ padding: '12px 18px', color: 'var(--text-muted)', fontWeight: 600 }}>Customer</th>
                      <th style={{ padding: '12px 18px', color: 'var(--text-muted)', fontWeight: 600 }}>Occurrence</th>
                      <th style={{ padding: '12px 18px', color: 'var(--text-muted)', fontWeight: 600 }}>Version</th>
                      <th style={{ padding: '12px 18px', color: 'var(--text-muted)', fontWeight: 600 }}>Status</th>
                      <th style={{ padding: '12px 18px', color: 'var(--text-muted)', fontWeight: 600 }}>Why Selected</th>
                      <th style={{ padding: '12px 18px', color: 'var(--text-muted)', fontWeight: 600 }}>Next Step</th>
                      <th style={{ padding: '12px 18px', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enrollments.map((enr) => (
                      <tr
                        key={enr.enrollmentId}
                        style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)', transition: 'background 0.15s' }}
                      >
                        {/* Customer */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ fontWeight: 700, color: '#fff' }}>{enr.customerName}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {enr.maskedPhone}
                          </div>
                        </td>

                        {/* Occurrence */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accent-cyan)' }}>
                              {enr.occurrenceId}
                            </span>
                            {(enr as any).occasionKind && (
                              <span
                                style={{
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  fontSize: '0.65rem',
                                  fontWeight: 700,
                                  background:
                                    (enr as any).occasionKind === 'WEDDING'
                                      ? 'rgba(168, 85, 247, 0.2)'
                                      : 'rgba(245, 158, 11, 0.2)',
                                  color:
                                    (enr as any).occasionKind === 'WEDDING'
                                      ? '#c084fc'
                                      : '#fbbf24',
                                  border: '1px solid rgba(255, 255, 255, 0.1)',
                                }}
                              >
                                {(enr as any).occasionKind}
                              </span>
                            )}
                            {((enr as any).planRevision || 1) > 1 && (
                              <span
                                style={{
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  fontSize: '0.65rem',
                                  fontWeight: 700,
                                  background: 'rgba(245, 158, 11, 0.2)',
                                  color: '#fbbf24',
                                  border: '1px solid rgba(245, 158, 11, 0.4)',
                                }}
                              >
                                Replanned (v{(enr as any).planRevision})
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {enr.occasionLocalDate}
                          </div>
                          {(enr as any).enquiryId && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--accent-cyan)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                              Enquiry #{(enr as any).enquiryId}
                              {(enr as any).itemRef?.productId && ` • ${(enr as any).itemRef.productId}`}
                            </div>
                          )}
                        </td>

                        {/* Version */}
                        <td style={{ padding: '14px 18px' }}>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.75rem',
                              padding: '2px 8px',
                              borderRadius: 4,
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              color: '#fff',
                            }}
                          >
                            v{enr.campaignVersion}
                          </span>
                        </td>

                        {/* Status & Reply Hold */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  fontWeight: 700,
                                  padding: '3px 8px',
                                  borderRadius: 6,
                                  background:
                                    enr.status === 'ACTIVE'
                                      ? 'rgba(16, 185, 129, 0.15)'
                                      : enr.status === 'CANCELLED'
                                      ? 'rgba(244, 63, 94, 0.15)'
                                      : 'rgba(255, 255, 255, 0.08)',
                                  color:
                                    enr.status === 'ACTIVE'
                                      ? '#34d399'
                                      : enr.status === 'CANCELLED'
                                      ? '#fb7185'
                                      : 'var(--text-secondary)',
                                  border:
                                    enr.status === 'ACTIVE'
                                      ? '1px solid rgba(16, 185, 129, 0.3)'
                                      : enr.status === 'CANCELLED'
                                      ? '1px solid rgba(244, 63, 94, 0.3)'
                                      : '1px solid rgba(255, 255, 255, 0.15)',
                                }}
                              >
                                {enr.status}
                              </span>

                              {(enr as any).anchorHistory && (enr as any).anchorHistory.length > 0 && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 700,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(99, 102, 241, 0.15)',
                                    color: '#818cf8',
                                    border: '1px solid rgba(99, 102, 241, 0.3)',
                                  }}
                                  title={`Replanned ${(enr as any).anchorHistory.length} time(s)`}
                                >
                                  <RefreshCw size={11} color="#818cf8" />
                                  <span>Replanned</span>
                                </span>
                              )}

                              {(enr as any).holdReason === 'STAFF_TAKEOVER' && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 800,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(245, 158, 11, 0.2)',
                                    color: '#fbbf24',
                                    border: '1px solid rgba(245, 158, 11, 0.45)',
                                  }}
                                >
                                  <span>Hold: staff takeover</span>
                                </span>
                              )}

                              {(enr as any).holdReason === 'CUSTOMER_INTERACTION' && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 800,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(245, 158, 11, 0.2)',
                                    color: '#fbbf24',
                                    border: '1px solid rgba(245, 158, 11, 0.45)',
                                  }}
                                >
                                  <span>Hold: customer interaction</span>
                                </span>
                              )}

                              {enr.replyHoldAt && !(enr as any).holdReason && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 800,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(245, 158, 11, 0.2)',
                                    color: '#fbbf24',
                                    border: '1px solid rgba(245, 158, 11, 0.45)',
                                  }}
                                  title={`Reply hold active since ${new Date(enr.replyHoldAt).toLocaleString()}`}
                                >
                                  <MessageCircle size={11} color="#fbbf24" />
                                  <span>Hold: reply</span>
                                </span>
                              )}

                              {(enr as any).stopReason?.startsWith('ENQUIRY_') && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 700,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(244, 63, 94, 0.15)',
                                    color: '#fda4af',
                                    border: '1px solid rgba(244, 63, 94, 0.3)',
                                  }}
                                >
                                  <span>Stopped: {(enr as any).stopReason.toLowerCase().replace('_', ' ')}</span>
                                </span>
                              )}

                              {enr.stepsSummary?.some((st: any) => (st as any).skipReason === 'ITEM_UNAVAILABLE' || (st as any).reason === 'ITEM_UNAVAILABLE') && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 700,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(245, 158, 11, 0.15)',
                                    color: '#fde68a',
                                    border: '1px solid rgba(245, 158, 11, 0.3)',
                                  }}
                                >
                                  <span>Skipped: item unavailable</span>
                                </span>
                              )}

                              {enr.holdResolvedAt && !enr.replyHoldAt && !(enr as any).holdReason && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 700,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(56, 189, 248, 0.1)',
                                    color: '#38bdf8',
                                    border: '1px solid rgba(56, 189, 248, 0.3)',
                                  }}
                                  title={`Hold resolved at ${new Date(enr.holdResolvedAt).toLocaleString()} by ${enr.holdResolvedBy || 'staff'}`}
                                >
                                  <Check size={11} color="#38bdf8" />
                                  <span>HOLD RESOLVED</span>
                                </span>
                              )}

                              {enr.goalReachedAt && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: '0.675rem',
                                    fontWeight: 800,
                                    padding: '2px 8px',
                                    borderRadius: 6,
                                    background: 'rgba(16, 185, 129, 0.2)',
                                    color: '#34d399',
                                    border: '1px solid rgba(16, 185, 129, 0.45)',
                                  }}
                                  title={`Goal reached at ${new Date(enr.goalReachedAt).toLocaleString()}${enr.goalOrderRef ? ` (Order: ${enr.goalOrderRef})` : ''}`}
                                >
                                  <Target size={11} color="#34d399" />
                                  <span>GOAL</span>
                                  {enr.goalOrderRef && (
                                    <span style={{ fontSize: '0.6rem', color: '#a7f3d0' }}>
                                      ({enr.goalOrderRef})
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>

                            {/* Step status chips summary */}
                            {enr.stepsSummary && enr.stepsSummary.length > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                {enr.stepsSummary.map((st) => {
                                  const isAccepted = st.state === 'PROVIDER_ACCEPTED' || st.state === 'accepted';
                                  const isSent = st.state === 'SENT' || st.state === 'sent';
                                  const isDelivered = st.state === 'DELIVERED' || st.state === 'delivered';
                                  const isRead = st.state === 'READ' || st.state === 'read';
                                  const isFailed = st.state === 'FAILED' || st.state === 'failed';

                                  let bg = 'rgba(255, 255, 255, 0.05)';
                                  let color = '#94a3b8';
                                  let border = '1px solid rgba(255, 255, 255, 0.1)';
                                  let label = st.state.toLowerCase();

                                  if (isRead) {
                                    bg = 'rgba(167, 139, 250, 0.2)';
                                    color = '#a78bfa';
                                    border = '1px solid rgba(167, 139, 250, 0.4)';
                                    label = 'read ✓✓';
                                  } else if (isDelivered) {
                                    bg = 'rgba(52, 211, 153, 0.2)';
                                    color = '#34d399';
                                    border = '1px solid rgba(52, 211, 153, 0.4)';
                                    label = 'delivered ✓';
                                  } else if (isSent) {
                                    bg = 'rgba(56, 189, 248, 0.2)';
                                    color = '#38bdf8';
                                    border = '1px solid rgba(56, 189, 248, 0.4)';
                                    label = 'sent';
                                  } else if (isAccepted) {
                                    bg = 'rgba(16, 185, 129, 0.2)';
                                    color = '#10b981';
                                    border = '1px solid rgba(16, 185, 129, 0.4)';
                                    label = 'accepted';
                                  } else if (isFailed) {
                                    bg = 'rgba(239, 68, 68, 0.2)';
                                    color = '#f87171';
                                    border = '1px solid rgba(239, 68, 68, 0.4)';
                                    label = 'failed';
                                  }

                                  return (
                                    <span
                                      key={st.stepId}
                                      style={{
                                        fontSize: '0.625rem',
                                        padding: '1px 5px',
                                        borderRadius: 4,
                                        background: bg,
                                        color,
                                        border,
                                        fontWeight: 600,
                                        fontFamily: 'var(--font-mono)',
                                      }}
                                      title={`${st.stepName}: ${st.state}`}
                                    >
                                      {st.stepName.split(' ')[0]}: {label}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </td>

                        {/* Why Selected */}
                        <td style={{ padding: '14px 18px', maxWidth: 220 }}>
                          <div
                            style={{
                              fontSize: '0.775rem',
                              color: 'var(--text-secondary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={enr.matchExplanation}
                          >
                            {enr.matchExplanation || 'all eligible'}
                          </div>
                        </td>

                        {/* Next Step */}
                        <td style={{ padding: '14px 18px' }}>
                          {enr.nextStepName ? (
                            <div>
                              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>
                                {enr.nextStepName}
                              </div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--accent-amber)', fontFamily: 'var(--font-mono)' }}>
                                {enr.nextLocalDate} {enr.nextLocalTime}
                              </div>
                            </div>
                          ) : (
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>No pending steps</span>
                          )}
                        </td>

                        {/* Action */}
                        <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                            <button
                              onClick={() => setSelectedTimelineCustomerId(enr.customerId)}
                              className="btn btn-secondary"
                              style={{
                                padding: '6px 10px',
                                fontSize: '0.75rem',
                                color: 'var(--accent-cyan)',
                                borderColor: 'rgba(6, 182, 212, 0.35)',
                                background: 'rgba(6, 182, 212, 0.08)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                              title="View Customer Lifecycle Timeline (Spec p28)"
                            >
                              <Clock size={13} />
                              Timeline
                            </button>
                            <button
                              onClick={() => handleInspectEnrollment(enr.enrollmentId)}
                              className="btn btn-secondary"
                              style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                            >
                              Inspect Steps ({enr.totalSteps})
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* STEP DETAIL INSPECTOR MODAL */}
      {/* ==================================================================== */}
      {selectedEnrollmentData && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(6px)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: 780,
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: 28,
              background: '#0f172a',
              border: '1px solid rgba(99, 102, 241, 0.3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                  Enrollment Step Schedule
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  ID: {selectedEnrollmentData.enrollment.enrollmentId} &bull; Key: {selectedEnrollmentData.enrollment.enrollmentKey}
                </span>
              </div>
              <button
                onClick={() => setSelectedEnrollmentData(null)}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: 8,
                  width: 32,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Customer & Occasion Info Banner */}
            <div
              style={{
                padding: '16px',
                borderRadius: 10,
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 12,
                fontSize: '0.825rem',
              }}
            >
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Customer:</span>{' '}
                <strong style={{ color: '#fff' }}>{selectedEnrollmentData.customer?.firstName || 'Unknown'}</strong> (
                {selectedEnrollmentData.customer?.maskedPhone})
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Occurrence:</span>{' '}
                <strong style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                  {selectedEnrollmentData.enrollment.occurrenceId}
                </strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Occasion Date:</span>{' '}
                <strong style={{ color: '#fff' }}>{selectedEnrollmentData.enrollment.occasionLocalDate}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Pinned Version:</span>{' '}
                <strong style={{ color: 'var(--accent-emerald)' }}>v{selectedEnrollmentData.enrollment.campaignVersion}</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => setSelectedTimelineCustomerId(selectedEnrollmentData.enrollment.customerId)}
                  className="btn btn-secondary"
                  style={{
                    padding: '4px 10px',
                    fontSize: '0.75rem',
                    color: 'var(--accent-cyan)',
                    borderColor: 'rgba(6, 182, 212, 0.4)',
                    background: 'rgba(6, 182, 212, 0.1)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Clock size={13} />
                  Lifecycle Timeline
                </button>
              </div>
            </div>

            {/* Inbound Customer Reply Hold Banner (Spec p14, p20) */}
            {selectedEnrollmentData.enrollment.replyHoldAt && (
              <div
                style={{
                  padding: '14px 18px',
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.12)',
                  border: '1px solid rgba(245, 158, 11, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: 'rgba(245, 158, 11, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <MessageCircle size={20} color="#fbbf24" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 800, color: '#fbbf24' }}>
                      Customer Reply Hold Active (Spec p14, p20)
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#fef3c7', marginTop: 2 }}>
                      Inbound reply received at {new Date(selectedEnrollmentData.enrollment.replyHoldAt).toLocaleString()} &bull; Attribution:{' '}
                      <strong>
                        {selectedEnrollmentData.enrollment.replyAttribution === 'CAMPAIGN'
                          ? 'Exact Campaign Message Reply'
                          : 'Store Conversation Hold (Not Campaign Attribution)'}
                      </strong>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      fontSize: '0.725rem',
                      fontWeight: 800,
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: 'rgba(245, 158, 11, 0.25)',
                      color: '#fbbf24',
                      border: '1px solid rgba(245, 158, 11, 0.5)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    ⏸ SALES STEPS HELD
                  </span>
                  {canResolveHold && (
                    <button
                      onClick={() => {
                        setResolveHoldCause('Staff resolved customer conversation hold');
                        setResolveHoldSupporting('');
                        setResolveHoldError(null);
                        setResolveHoldModalOpen(true);
                      }}
                      className="btn btn-secondary"
                      style={{
                        padding: '6px 14px',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        background: 'rgba(245, 158, 11, 0.25)',
                        color: '#fef08a',
                        borderColor: 'rgba(245, 158, 11, 0.5)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: 'pointer',
                      }}
                    >
                      <Play size={13} />
                      Resolve Hold
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Hold Resolved Banner */}
            {selectedEnrollmentData.enrollment.holdResolvedAt && !selectedEnrollmentData.enrollment.replyHoldAt && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  fontSize: '0.8rem',
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    background: 'rgba(56, 189, 248, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Check size={18} color="#38bdf8" />
                </div>
                <div>
                  <div style={{ color: '#38bdf8', fontWeight: 800 }}>Customer Reply Hold Resolved</div>
                  <div style={{ color: '#bae6fd', fontSize: '0.75rem', marginTop: 2 }}>
                    Resolved at {new Date(selectedEnrollmentData.enrollment.holdResolvedAt).toLocaleString()} by{' '}
                    <strong>{selectedEnrollmentData.enrollment.holdResolvedBy || 'Staff'}</strong>
                    {selectedEnrollmentData.enrollment.holdResolutionCause && (
                      <> &bull; Cause: <em>{selectedEnrollmentData.enrollment.holdResolutionCause}</em></>
                    )}
                    . Future steps will be evaluated at scheduled times.
                  </div>
                </div>
              </div>
            )}

            {/* Goal Reached Banner (Spec p11, p33) */}
            {selectedEnrollmentData.enrollment.goalReachedAt && (
              <div
                style={{
                  padding: '14px 18px',
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.12)',
                  border: '1px solid rgba(16, 185, 129, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: 'rgba(16, 185, 129, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Target size={20} color="#34d399" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 800, color: '#34d399' }}>
                      Campaign Goal Reached (Spec p11, p33)
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#d1fae5', marginTop: 2 }}>
                      Recorded at {new Date(selectedEnrollmentData.enrollment.goalReachedAt).toLocaleString()} &bull; Source:{' '}
                      <strong>{selectedEnrollmentData.enrollment.goalSource || 'STAFF_MANUAL'}</strong>
                      {selectedEnrollmentData.enrollment.goalOrderRef && (
                        <>
                          {' '}&bull; Order Ref:{' '}
                          <code style={{ color: '#6ee7b7', fontFamily: 'var(--font-mono)' }}>
                            {selectedEnrollmentData.enrollment.goalOrderRef}
                          </code>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <span
                  style={{
                    fontSize: '0.725rem',
                    fontWeight: 800,
                    padding: '4px 10px',
                    borderRadius: 6,
                    background: 'rgba(16, 185, 129, 0.25)',
                    color: '#34d399',
                    border: '1px solid rgba(16, 185, 129, 0.5)',
                    letterSpacing: '0.04em',
                  }}
                >
                  🎯 GOAL RECORDED (SALES STEPS STOP)
                </span>
              </div>
            )}

            {/* Mark Goal Action Bar (Owner/Admin only, shown if goal not yet reached) */}
            {!selectedEnrollmentData.enrollment.goalReachedAt && canMarkGoal && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 16px',
                  borderRadius: 8,
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.15)',
                  flexWrap: 'wrap',
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: '0.825rem', fontWeight: 700, color: '#fff' }}>
                    Record Occasion Purchase or Staff Goal
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Marking goal stops sales follow-ups while letting independent greetings send (Spec p11, p33).
                  </div>
                </div>
                <button
                  onClick={() => {
                    setMarkGoalCause('Customer completed occasion shopping');
                    setMarkGoalOrderRef('');
                    setMarkGoalSupporting('');
                    setMarkGoalError(null);
                    setMarkGoalModalOpen(true);
                  }}
                  className="btn btn-secondary"
                  style={{
                    padding: '6px 14px',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    borderColor: 'rgba(16, 185, 129, 0.4)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                  }}
                >
                  <Target size={14} />
                  Mark Goal Complete
                </button>
              </div>
            )}

            {/* Why Selected Match Explanation */}
            <div
              style={{
                padding: '12px 16px',
                borderRadius: 8,
                background: 'rgba(99, 102, 241, 0.08)',
                border: '1px solid rgba(99, 102, 241, 0.25)',
                fontSize: '0.8rem',
              }}
            >
              <span style={{ color: '#c7d2fe', fontWeight: 700 }}>Why this customer was selected:</span>{' '}
              <span style={{ color: '#fff' }}>{selectedEnrollmentData.enrollment.matchExplanation}</span>
            </div>

            {/* Execution Steps List */}
            <div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
                Planned Step Sequence ({selectedEnrollmentData.executions.length} Steps)
              </h4>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {selectedEnrollmentData.executions.map((step) => {
                  const getStateBadge = (state: string) => {
                    switch (state) {
                      case 'SCHEDULED':
                        return { bg: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)', label: 'SCHEDULED' };
                      case 'DEFERRED':
                        return { bg: 'rgba(14, 165, 233, 0.15)', color: '#38bdf8', border: '1px solid rgba(14, 165, 233, 0.3)', label: 'DEFERRED' };
                      case 'EVALUATING':
                        return { bg: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '1px solid rgba(168, 85, 247, 0.3)', label: 'EVALUATING' };
                      case 'DISPATCHING':
                        return { bg: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc', border: '1px solid rgba(99, 102, 241, 0.3)', label: 'DISPATCHING' };
                      case 'PROVIDER_ACCEPTED':
                      case 'accepted':
                        return { bg: 'rgba(16, 185, 129, 0.25)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.5)', label: 'ACCEPTED' };
                      case 'SENT':
                      case 'sent':
                        return { bg: 'rgba(56, 189, 248, 0.25)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.5)', label: 'SENT' };
                      case 'DELIVERED':
                      case 'delivered':
                        return { bg: 'rgba(52, 211, 153, 0.25)', color: '#34d399', border: '1px solid rgba(52, 211, 153, 0.5)', label: 'DELIVERED ✓' };
                      case 'READ':
                      case 'read':
                        return { bg: 'rgba(167, 139, 250, 0.25)', color: '#a78bfa', border: '1px solid rgba(167, 139, 250, 0.5)', label: 'READ ✓✓' };
                      case 'SKIPPED':
                        return { bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.3)', label: 'SKIPPED' };
                      case 'CANCELLED':
                        return { bg: 'rgba(244, 63, 94, 0.15)', color: '#fb7185', border: '1px solid rgba(244, 63, 94, 0.3)', label: 'CANCELLED' };
                      case 'EXPIRED':
                        return { bg: 'rgba(148, 163, 184, 0.15)', color: '#94a3b8', border: '1px solid rgba(148, 163, 184, 0.3)', label: 'EXPIRED' };
                      case 'BLOCKED':
                        return { bg: 'rgba(249, 115, 22, 0.15)', color: '#fb923c', border: '1px solid rgba(249, 115, 22, 0.3)', label: 'BLOCKED' };
                      case 'FAILED':
                      case 'failed':
                        return { bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)', label: 'FAILED' };
                      case 'OUTCOME_UNKNOWN':
                      default:
                        return { bg: 'rgba(100, 116, 139, 0.15)', color: '#94a3b8', border: '1px solid rgba(100, 116, 139, 0.3)', label: state };
                    }
                  };
                  const badgeStyle = getStateBadge(step.state);

                  return (
                    <div
                      key={step.executionId}
                      style={{
                        padding: '16px',
                        borderRadius: 10,
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: '0.95rem', fontWeight: 800, color: '#fff' }}>
                            {step.stepName || step.stepId}
                          </span>
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              padding: '3px 8px',
                              borderRadius: 6,
                              background: badgeStyle.bg,
                              color: badgeStyle.color,
                              border: badgeStyle.border,
                            }}
                          >
                            {badgeStyle.label}
                          </span>
                        </div>

                        <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                          Step ID: {step.stepId}
                        </div>
                      </div>

                      {/* Step Schedule Times */}
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                          gap: 8,
                          fontSize: '0.775rem',
                          marginTop: 4,
                        }}
                      >
                        <div style={{ background: 'rgba(0, 0, 0, 0.25)', padding: '8px 10px', borderRadius: 6 }}>
                          <span style={{ color: 'var(--text-muted)' }}>Local Time:</span>{' '}
                          <strong style={{ color: '#fff' }}>
                            {step.localDate} {step.localTime} ({step.timezone})
                          </strong>
                        </div>
                        <div style={{ background: 'rgba(0, 0, 0, 0.25)', padding: '8px 10px', borderRadius: 6 }}>
                          <span style={{ color: 'var(--text-muted)' }}>UTC Instant:</span>{' '}
                          <strong style={{ color: '#c7d2fe', fontFamily: 'var(--font-mono)' }}>
                            {new Date(step.dueAt).toISOString().replace('.000Z', 'Z')}
                          </strong>
                        </div>
                        {step.originalDueAt &&
                          new Date(step.originalDueAt).getTime() !== new Date(step.dueAt).getTime() && (
                            <div style={{ background: 'rgba(245, 158, 11, 0.1)', padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(245, 158, 11, 0.25)' }}>
                              <span style={{ color: '#fbbf24', fontWeight: 600 }}>Original Due:</span>{' '}
                              <strong style={{ color: '#fef08a', fontFamily: 'var(--font-mono)' }}>
                                {new Date(step.originalDueAt).toISOString().replace('.000Z', 'Z')}
                              </strong>
                            </div>
                          )}
                        <div style={{ background: 'rgba(0, 0, 0, 0.25)', padding: '8px 10px', borderRadius: 6 }}>
                          <span style={{ color: 'var(--text-muted)' }}>Expires At:</span>{' '}
                          <strong style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                            {new Date(step.expiresAt).toISOString().replace('.000Z', 'Z')}
                          </strong>
                        </div>
                      </div>

                      {/* Delivery Status Events Timeline (Spec p27) */}
                      {(step.sentAt || step.deliveredAt || step.readAt || step.failedAt) && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 8,
                            padding: '8px 12px',
                            borderRadius: 6,
                            background: 'rgba(255, 255, 255, 0.03)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            fontSize: '0.75rem',
                          }}
                        >
                          <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>Delivery Timeline:</span>
                          {step.sentAt && (
                            <span style={{ color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(56, 189, 248, 0.25)' }}>
                              Sent: {new Date(step.sentAt).toLocaleTimeString()}
                            </span>
                          )}
                          {step.deliveredAt && (
                            <span style={{ color: '#34d399', background: 'rgba(52, 211, 153, 0.1)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(52, 211, 153, 0.25)' }}>
                              Delivered: {new Date(step.deliveredAt).toLocaleTimeString()}
                            </span>
                          )}
                          {step.readAt && (
                            <span style={{ color: '#a78bfa', background: 'rgba(167, 139, 250, 0.1)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(167, 139, 250, 0.25)', fontWeight: 700 }}>
                              Read: {new Date(step.readAt).toLocaleTimeString()}
                            </span>
                          )}
                          {step.failedAt && (
                            <span style={{ color: '#f87171', background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(239, 68, 68, 0.25)' }}>
                              Failed: {new Date(step.failedAt).toLocaleTimeString()}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Template and Prerequisite */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: '0.775rem', color: 'var(--text-secondary)' }}>
                        <div>
                          Template:{' '}
                          <code style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                            {step.templateRef?.id} (rev {step.templateRef?.revision})
                          </code>
                        </div>
                        <div>
                          Prerequisite: <strong style={{ color: '#fff' }}>{step.prerequisite}</strong>
                        </div>
                      </div>

                      {/* Provider Message ID & Last Error Category */}
                      {(step.providerMessageId || step.deliveryIntent?.providerMessageId) && (
                        <div
                          style={{
                            fontSize: '0.75rem',
                            background: 'rgba(56, 189, 248, 0.08)',
                            border: '1px solid rgba(56, 189, 248, 0.25)',
                            padding: '6px 10px',
                            borderRadius: 6,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span style={{ color: '#38bdf8', fontWeight: 700 }}>Provider Message ID:</span>
                          <code style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>
                            {step.providerMessageId || step.deliveryIntent?.providerMessageId}
                          </code>
                        </div>
                      )}

                      {(step.lastErrorCategory || step.deliveryIntent?.lastErrorCategory) && (
                        <div
                          style={{
                            fontSize: '0.75rem',
                            background: 'rgba(239, 68, 68, 0.08)',
                            border: '1px solid rgba(239, 68, 68, 0.25)',
                            padding: '6px 10px',
                            borderRadius: 6,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span style={{ color: '#f87171', fontWeight: 700 }}>Last Error Category:</span>
                          <span style={{ color: '#fca5a5' }}>
                            {step.lastErrorCategory || step.deliveryIntent?.lastErrorCategory}
                          </span>
                        </div>
                      )}

                      {/* Primary Skip/Block/Defer Reason if applicable */}
                      {step.skipReason && (
                        <div
                          style={{
                            fontSize: '0.75rem',
                            color:
                              step.skipReason === 'SKIPPED_GOAL_REACHED'
                                ? '#34d399'
                                : step.skipReason === 'SKIPPED_REPLY_HOLD'
                                ? '#f59e0b'
                                : step.skipReason.includes('Deferred') || step.skipReason === 'DEFERRED_CONTACT_CAP'
                                ? '#38bdf8'
                                : '#fbbf24',
                            background:
                              step.skipReason === 'SKIPPED_GOAL_REACHED'
                                ? 'rgba(16, 185, 129, 0.15)'
                                : step.skipReason === 'SKIPPED_REPLY_HOLD'
                                ? 'rgba(245, 158, 11, 0.15)'
                                : step.skipReason.includes('Deferred') || step.skipReason === 'DEFERRED_CONTACT_CAP'
                                ? 'rgba(56, 189, 248, 0.12)'
                                : 'rgba(245, 158, 11, 0.08)',
                            padding: '8px 12px',
                            borderRadius: 6,
                            border:
                              step.skipReason === 'SKIPPED_GOAL_REACHED'
                                ? '1px solid rgba(16, 185, 129, 0.45)'
                                : step.skipReason === 'SKIPPED_REPLY_HOLD'
                                ? '1px solid rgba(245, 158, 11, 0.45)'
                                : step.skipReason.includes('Deferred') || step.skipReason === 'DEFERRED_CONTACT_CAP'
                                ? '1px solid rgba(56, 189, 248, 0.35)'
                                : '1px solid rgba(245, 158, 11, 0.25)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          {step.skipReason === 'SKIPPED_GOAL_REACHED' ? (
                            <Target size={14} color="#34d399" style={{ flexShrink: 0 }} />
                          ) : (
                            <AlertTriangle
                              size={14}
                              color={
                                step.skipReason.includes('Deferred') || step.skipReason === 'DEFERRED_CONTACT_CAP'
                                  ? '#38bdf8'
                                  : '#fbbf24'
                              }
                              style={{ flexShrink: 0 }}
                            />
                          )}
                          <div>
                            <strong>
                              {step.skipReason === 'SKIPPED_GOAL_REACHED'
                                ? 'Skipped on Goal Reached (stopOnGoal=true, Spec p33 Reason Precedence):'
                                : step.skipReason === 'SKIPPED_REPLY_HOLD'
                                ? 'Skipped on Reply Hold (stopOnReply=true, Spec p20):'
                                : step.skipReason.includes('Deferred') || step.skipReason === 'DEFERRED_CONTACT_CAP'
                                ? 'Deferred on Contact Cap (Spec p18):'
                                : step.skipReason === 'SKIPPED_CONTACT_CAP'
                                ? 'Skipped on Contact Cap (Spec p18):'
                                : 'Primary Reason (Spec p33):'}
                            </strong>{' '}
                            <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4, fontFamily: 'var(--font-mono)' }}>
                              {step.skipReason === 'SKIPPED_GOAL_REACHED'
                                ? 'SKIPPED_GOAL_REACHED (Goal precedes reply hold)'
                                : step.skipReason === 'DEFERRED_CONTACT_CAP'
                                ? 'Deferred: another campaign contacted this customer'
                                : step.skipReason}
                            </code>
                          </div>
                        </div>
                      )}

                      {/* Frozen Delivery Intent Summary (Spec p23, p25) */}
                      {step.deliveryIntent && (
                        <div
                          style={{
                            marginTop: 6,
                            padding: '12px 14px',
                            borderRadius: 8,
                            background: 'rgba(99, 102, 241, 0.08)',
                            border: '1px solid rgba(99, 102, 241, 0.25)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 800, color: '#c7d2fe', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                Frozen Delivery Intent (Spec p23, p25)
                              </span>
                              <span
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  fontWeight: 700,
                                  background: step.deliveryIntent.state === 'PREPARED_DRY' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                                  color: step.deliveryIntent.state === 'PREPARED_DRY' ? '#fbbf24' : '#34d399',
                                  border: step.deliveryIntent.state === 'PREPARED_DRY' ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
                                }}
                              >
                                {step.deliveryIntent.state}
                              </span>
                            </div>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              Key: {step.deliveryIntent.deliveryKey}
                            </span>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, fontSize: '0.775rem' }}>
                            <div>
                              <span style={{ color: 'var(--text-muted)' }}>Masked Recipient:</span>{' '}
                              <strong style={{ color: '#fff' }}>{step.deliveryIntent.maskedRecipient}</strong>{' '}
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>(v{step.deliveryIntent.recipientVersion})</span>
                            </div>
                            <div>
                              <span style={{ color: 'var(--text-muted)' }}>Template Revision:</span>{' '}
                              <strong style={{ color: 'var(--accent-cyan)' }}>
                                {step.deliveryIntent.templateRef?.id} (rev {step.deliveryIntent.templateRef?.revision}, {step.deliveryIntent.templateRef?.language})
                              </strong>
                            </div>
                          </div>

                          {/* Bound Parameters */}
                          {step.deliveryIntent.parameters && Object.keys(step.deliveryIntent.parameters).length > 0 && (
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                                Late-Bound Parameters (Ordered by Variable Index):
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {Object.entries(step.deliveryIntent.parameters).map(([key, val]) => (
                                  <span
                                    key={key}
                                    style={{
                                      fontSize: '0.725rem',
                                      padding: '2px 8px',
                                      borderRadius: 4,
                                      background: 'rgba(255, 255, 255, 0.05)',
                                      border: '1px solid rgba(255, 255, 255, 0.1)',
                                      fontFamily: 'var(--font-mono)',
                                    }}
                                  >
                                    <span style={{ color: '#a5b4fc' }}>{key}:</span> <strong style={{ color: '#fff' }}>"{String(val)}"</strong>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          <div style={{ fontSize: '0.675rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            Payload Hash: {step.deliveryIntent.payloadHash}
                          </div>
                        </div>
                      )}

                      {/* Dispatch Attempts History (Spec p27) */}
                      {(() => {
                        const attempts = step.attempts?.length ? step.attempts : step.deliveryIntent?.attempts;
                        if (!attempts || attempts.length === 0) return null;
                        return (
                          <div
                            style={{
                              marginTop: 6,
                              padding: '10px 12px',
                              borderRadius: 8,
                              background: 'rgba(255, 255, 255, 0.02)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 800, color: '#e2e8f0', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                Dispatch Attempts ({attempts.length})
                              </span>
                              {step.retryAt && (
                                <span style={{ fontSize: '0.7rem', color: '#fbbf24' }}>
                                  Next Retry: {new Date(step.retryAt).toLocaleTimeString()}
                                </span>
                              )}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {attempts.map((att, idx) => (
                                <div
                                  key={att.attemptId || idx}
                                  style={{
                                    padding: '6px 10px',
                                    borderRadius: 6,
                                    background: 'rgba(0, 0, 0, 0.25)',
                                    border: '1px solid rgba(255, 255, 255, 0.06)',
                                    fontSize: '0.725rem',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 3,
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <strong style={{ color: '#fff' }}>Attempt #{att.attemptNumber || idx + 1}</strong>
                                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                        ({att.attemptId})
                                      </span>
                                      <span
                                        style={{
                                          fontSize: '0.65rem',
                                          padding: '1px 6px',
                                          borderRadius: 4,
                                          fontWeight: 700,
                                          ...getStateBadge(att.state),
                                        }}
                                      >
                                        {att.state}
                                      </span>
                                    </div>
                                    <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)' }}>
                                      {new Date(att.attemptedAt).toLocaleTimeString()}
                                    </span>
                                  </div>
                                  {att.providerMessageId && (
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                      Provider ID: <code style={{ color: '#38bdf8', fontFamily: 'var(--font-mono)' }}>{att.providerMessageId}</code>
                                    </div>
                                  )}
                                  {(att.errorCategory || att.errorMessage) && (
                                    <div style={{ fontSize: '0.7rem', color: '#f87171' }}>
                                      Error [{att.errorCategory || 'ERROR'}]: {att.errorMessage}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <button
                onClick={() => setSelectedEnrollmentData(null)}
                className="btn btn-secondary"
                style={{ padding: '8px 18px', fontSize: '0.85rem' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resolve Hold Confirmation Modal */}
      {resolveHoldModalOpen && selectedEnrollmentData && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: 20,
          }}
          onClick={() => setResolveHoldModalOpen(false)}
        >
          <div
            style={{
              background: '#181b26',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              borderRadius: 12,
              padding: 24,
              maxWidth: 500,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Play size={18} color="#fbbf24" />
              </div>
              <div>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                  Resolve Customer Reply Hold
                </h3>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Customer: {selectedEnrollmentData.customer?.firstName || 'Customer'} ({selectedEnrollmentData.customer?.maskedPhone || selectedEnrollmentData.enrollment.customerId})
                </div>
              </div>
            </div>

            <div
              style={{
                fontSize: '0.8rem',
                color: '#fef3c7',
                background: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                padding: '10px 12px',
                borderRadius: 8,
                lineHeight: 1.45,
              }}
            >
              <strong>Spec p11 / p20 Rule:</strong> Resolving a hold re-evaluates <em>future steps only</em>. Any step whose scheduled window elapsed while on hold will remain skipped (missed steps never replay).
            </div>

            {resolveHoldError && (
              <div
                style={{
                  fontSize: '0.8rem',
                  color: '#f87171',
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  padding: '8px 12px',
                  borderRadius: 6,
                }}
              >
                {resolveHoldError}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
                  Resolution Cause / Reason <span style={{ color: '#f87171' }}>*</span>
                </label>
                <input
                  type="text"
                  value={resolveHoldCause}
                  onChange={(e) => setResolveHoldCause(e.target.value)}
                  placeholder="e.g. Staff called customer and answered product questions"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    fontSize: '0.85rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                  Supporting Record / Ticket / Note (Optional)
                </label>
                <input
                  type="text"
                  value={resolveHoldSupporting}
                  onChange={(e) => setResolveHoldSupporting(e.target.value)}
                  placeholder="e.g. Ticket #4089 or phone note"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    fontSize: '0.85rem',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button
                onClick={() => setResolveHoldModalOpen(false)}
                className="btn btn-secondary"
                disabled={submittingResolveHold}
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handleResolveHoldSubmit}
                disabled={submittingResolveHold || !resolveHoldCause.trim()}
                className="btn btn-primary"
                style={{
                  padding: '8px 18px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  background: '#f59e0b',
                  borderColor: '#d97706',
                  color: '#000',
                  cursor: submittingResolveHold || !resolveHoldCause.trim() ? 'not-allowed' : 'pointer',
                  opacity: submittingResolveHold || !resolveHoldCause.trim() ? 0.6 : 1,
                }}
              >
                {submittingResolveHold ? 'Resolving...' : 'Confirm Resolve Hold'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mark Goal Confirmation Modal */}
      {markGoalModalOpen && selectedEnrollmentData && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: 20,
          }}
          onClick={() => setMarkGoalModalOpen(false)}
        >
          <div
            style={{
              background: '#181b26',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              borderRadius: 12,
              padding: 24,
              maxWidth: 520,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Target size={20} color="#34d399" />
              </div>
              <div>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                  Mark Campaign Goal Reached
                </h3>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Customer: {selectedEnrollmentData.customer?.firstName || 'Customer'} ({selectedEnrollmentData.customer?.maskedPhone || selectedEnrollmentData.enrollment.customerId})
                </div>
              </div>
            </div>

            <div
              style={{
                fontSize: '0.8rem',
                color: '#d1fae5',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                padding: '10px 12px',
                borderRadius: 8,
                lineHeight: 1.45,
              }}
            >
              <strong>Spec p11 / p33 Goal Semantics:</strong> Steps configured with <code>stopOnGoal: true</code> (sales reminders) will be skipped. Independent greeting steps (<code>stopOnGoal: false</code>) will still send on schedule.
            </div>

            {markGoalError && (
              <div
                style={{
                  fontSize: '0.8rem',
                  color: '#f87171',
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  padding: '8px 12px',
                  borderRadius: 6,
                }}
              >
                {markGoalError}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
                  Occasion Order Ref (Optional)
                </label>
                <input
                  type="text"
                  value={markGoalOrderRef}
                  onChange={(e) => setMarkGoalOrderRef(e.target.value)}
                  placeholder="e.g. ord_lakshmi_001"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    fontSize: '0.85rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                  Cause / Evidence
                </label>
                <input
                  type="text"
                  value={markGoalCause}
                  onChange={(e) => setMarkGoalCause(e.target.value)}
                  placeholder="e.g. Customer purchased saree during birthday occasion"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    fontSize: '0.85rem',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                  Supporting Record / Bill No. (Optional)
                </label>
                <input
                  type="text"
                  value={markGoalSupporting}
                  onChange={(e) => setMarkGoalSupporting(e.target.value)}
                  placeholder="e.g. POS-2026-9021"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    fontSize: '0.85rem',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button
                onClick={() => setMarkGoalModalOpen(false)}
                className="btn btn-secondary"
                disabled={submittingMarkGoal}
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handleMarkGoalSubmit}
                disabled={submittingMarkGoal}
                className="btn btn-primary"
                style={{
                  padding: '8px 18px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  background: '#10b981',
                  borderColor: '#059669',
                  color: '#fff',
                  cursor: submittingMarkGoal ? 'not-allowed' : 'pointer',
                  opacity: submittingMarkGoal ? 0.6 : 1,
                }}
              >
                {submittingMarkGoal ? 'Marking Goal...' : 'Confirm Mark Goal'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Campaign Lifecycle Modals */}
      <PauseModal
        isOpen={pauseModalOpen}
        campaignId={campaign.campaignId}
        campaignName={campaign.name}
        onClose={() => setPauseModalOpen(false)}
        onSuccess={() => {
          onCampaignUpdated?.();
          if (activeTab === 'activity') {
            fetchEnrollments();
          }
        }}
      />

      <ResumeModal
        isOpen={resumeModalOpen}
        campaignId={campaign.campaignId}
        campaignName={campaign.name}
        onClose={() => setResumeModalOpen(false)}
        onSuccess={() => {
          onCampaignUpdated?.();
          if (activeTab === 'activity') {
            fetchEnrollments();
          }
        }}
      />

      <ArchiveModal
        isOpen={archiveModalOpen}
        campaignId={campaign.campaignId}
        campaignName={campaign.name}
        onClose={() => setArchiveModalOpen(false)}
        onSuccess={() => {
          onCampaignUpdated?.();
          if (activeTab === 'activity') {
            fetchEnrollments();
          }
        }}
      />

      {/* Customer Lifecycle Timeline Modal (Spec p28) */}
      {selectedTimelineCustomerId && (
        <CustomerTimelineModal
          campaignId={campaign.campaignId}
          customerId={selectedTimelineCustomerId}
          onClose={() => setSelectedTimelineCustomerId(null)}
        />
      )}
    </div>
  );
}

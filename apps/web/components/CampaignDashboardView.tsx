'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart3,
  Download,
  RefreshCw,
  Users,
  CheckCircle2,
  Clock,
  AlertTriangle,
  MessageCircle,
  Target,
  DollarSign,
  TrendingUp,
  Layers,
  ArrowRight,
  ShieldCheck,
  Info,
  Calendar,
  AlertCircle,
  FileSpreadsheet,
  ShoppingBag,
  Gift,
  Sparkles,
} from 'lucide-react';
import { CampaignReport, AttributedOrder } from '@grovastra/shared';

export interface CampaignDashboardViewProps {
  campaignId: string;
  campaignName: string;
  presetId?: string;
  status: string;
  onViewActivity?: () => void;
}

export function CampaignDashboardView({
  campaignId,
  campaignName,
  presetId,
  status,
  onViewActivity,
}: CampaignDashboardViewProps) {
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [welcomeSummary, setWelcomeSummary] = useState<any | null>(null);
  const [repeatSummary, setRepeatSummary] = useState<any | null>(null);
  const [occasionSummary, setOccasionSummary] = useState<any | null>(null);
  const [outfitSummary, setOutfitSummary] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportingCsv, setExportingCsv] = useState(false);

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/campaigns/${campaignId}/report`);
      if (res.ok) {
        const data: CampaignReport = await res.json();
        setReport(data);
      } else {
        const err = await res.json();
        setError(err?.error?.message || 'Failed to load campaign report');
      }

      if (
        presetId === 'WELCOME_NEW_CUSTOMER' ||
        presetId === 'welcome' ||
        presetId === 'welcome_new_customer'
      ) {
        const welcomeRes = await fetch(`/api/campaigns/${campaignId}/welcome/summary`).catch(() => null);
        if (welcomeRes && welcomeRes.ok) {
          const wData = await welcomeRes.json();
          setWelcomeSummary(wData);
        }
      }

      if (
        presetId === 'FIRST_TO_SECOND_PURCHASE' ||
        presetId === 'first_to_second_purchase' ||
        presetId === 'second_purchase'
      ) {
        const repeatRes = await fetch(`/api/campaigns/${campaignId}/repeat-purchase/summary`).catch(() => null);
        if (repeatRes && repeatRes.ok) {
          const rData = await repeatRes.json();
          setRepeatSummary(rData);
        }
      }

      if (
        presetId === 'gift_wedding_reminder' ||
        presetId === 'gift_wedding'
      ) {
        const occRes = await fetch(`/api/campaigns/${campaignId}/occasion-reminders/summary`).catch(() => null);
        if (occRes && occRes.ok) {
          const oData = await occRes.json();
          setOccasionSummary(oData);
        }
      }

      if (
        presetId === 'complete_the_outfit' ||
        presetId === 'outfit_completion'
      ) {
        const outfitRes = await fetch(`/api/campaigns/${campaignId}/complete-outfit/summary`).catch(() => null);
        if (outfitRes && outfitRes.ok) {
          const outData = await outfitRes.json();
          setOutfitSummary(outData);
        }
      }
    } catch {
      setError('Network error fetching campaign report');
    } finally {
      setLoading(false);
    }
  }, [campaignId, presetId]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleExportCsv = async () => {
    try {
      setExportingCsv(true);
      const res = await fetch(`/api/campaigns/${campaignId}/export/csv`);
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toISOString().split('T')[0];
        a.download = `campaign_${campaignId}_report_${dateStr}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      } else {
        alert('Failed to generate CSV export');
      }
    } catch {
      alert('Network error downloading CSV export');
    } finally {
      setExportingCsv(false);
    }
  };

  if (loading && !report) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
        <RefreshCw size={28} className="animate-spin" style={{ margin: '0 auto 12px' }} />
        <div>Loading Campaign Performance & Attribution Report...</div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div
        className="glass-panel"
        style={{
          padding: 24,
          background: 'rgba(239, 68, 68, 0.1)',
          borderColor: 'rgba(239, 68, 68, 0.3)',
          textAlign: 'center',
        }}
      >
        <AlertCircle size={32} color="var(--accent-rose)" style={{ margin: '0 auto 12px' }} />
        <div style={{ color: '#fff', fontWeight: 700, marginBottom: 8 }}>Unable to load campaign metrics</div>
        <div style={{ color: '#fecdd3', fontSize: '0.85rem', marginBottom: 16 }}>{error}</div>
        <button onClick={fetchReport} className="btn btn-secondary">
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Top Controls Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 16,
          padding: '16px 20px',
          background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: 12,
          border: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#fff', margin: 0 }}>
              Performance & Attribution Dashboard
            </h3>
            <span
              style={{
                fontSize: '0.7rem',
                padding: '2px 8px',
                borderRadius: 6,
                background: 'rgba(99, 102, 241, 0.15)',
                color: 'var(--accent-cyan)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                fontWeight: 700,
              }}
            >
              Spec p28
            </span>
          </div>
          <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
            Accurate evidence counts &bull; Delivery is not a sale &bull; Single-attribution policy
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={fetchReport}
            className="btn btn-secondary"
            disabled={loading}
            style={{ padding: '8px 14px', fontSize: '0.8rem' }}
            title="Refresh metrics"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>

          <button
            onClick={handleExportCsv}
            className="btn btn-primary"
            disabled={exportingCsv}
            style={{
              padding: '8px 16px',
              fontSize: '0.8rem',
              background: 'linear-gradient(135deg, #059669, #10b981)',
              borderColor: 'transparent',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: '0 4px 14px rgba(16, 185, 129, 0.25)',
            }}
          >
            <Download size={15} />
            {exportingCsv ? 'Generating CSV...' : 'Export CSV Report'}
          </button>
        </div>
      </div>

      {/* Welcome Campaign Specific Summary (F19) */}
      {welcomeSummary && (
        <div
          className="glass-panel"
          style={{
            padding: 24,
            border: '1px solid rgba(59, 130, 246, 0.3)',
            background: 'rgba(59, 130, 246, 0.04)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="badge badge-indigo">
                Welcome (New Customer)
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                First Qualifying Order Anchor • Autonomous Welcome Engine
              </span>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              1h delay default &bull; Next-day 10:00 AM outside-hours deferral
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 14,
            }}
          >
            {/* First Purchases Seen */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                First Purchases
              </div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {welcomeSummary.enrollments || welcomeSummary.totalEnrollments || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-cyan)', marginTop: 2 }}>
                {welcomeSummary.noCustomerIdentityCount || 0} anonymous bills &bull; {welcomeSummary.existingCustomersNotWelcomed || 0} existing not welcomed
              </div>
            </div>

            {/* Enrollments */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Enrollments</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {welcomeSummary.enrollments || welcomeSummary.totalEnrollments || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-emerald)', marginTop: 2 }}>
                {welcomeSummary.activeEnrollments ?? welcomeSummary.enrolled ?? 0} active &bull; {welcomeSummary.excludedCount || 0} excluded
              </div>
            </div>

            {/* Scheduled / Deferred */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Scheduled / Deferred</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {(welcomeSummary.scheduled || welcomeSummary.scheduledExecutions || 0) + (welcomeSummary.deferredCount || welcomeSummary.deferredExecutions || 0)}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-amber)', marginTop: 2 }}>
                {welcomeSummary.scheduled || welcomeSummary.scheduledExecutions || 0} due &bull; {welcomeSummary.deferredCount || welcomeSummary.deferredExecutions || 0} deferred
              </div>
            </div>

            {/* Delivered & Read */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Delivered & Read</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {welcomeSummary.delivered || welcomeSummary.deliveredExecutions || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                {welcomeSummary.read || welcomeSummary.readExecutions || 0} confirmed read &bull; {welcomeSummary.accepted || 0} accepted
              </div>
            </div>

            {/* Failures & Retries */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Failures & Retries</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {welcomeSummary.failed || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-rose)', marginTop: 2 }}>
                {welcomeSummary.retries?.executionsWithRetries || 0} retried &bull; {welcomeSummary.retries?.outcomeUnknownCount || 0} unknown ({welcomeSummary.retries?.note || 'no auto resend'})
              </div>
            </div>

            {/* Inbound Staff Reviews */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Staff Reviews</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {welcomeSummary.needsStaffReviewCount || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-amber)', marginTop: 2 }}>
                Wrong number / Opt-out replies flagged
              </div>
            </div>

            {/* Observational Repeat Purchases */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Repeat Purchases</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {welcomeSummary.observationalRepeatPurchases?.count || 0}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2, fontStyle: 'italic' }}>
                Observational only &bull; not sales attribution (spec p28)
              </div>
            </div>

            {/* Offer Redemption */}
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Offer Redemption</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-muted)', marginTop: 8 }}>
                {welcomeSummary.offerRedemption?.status || 'not available'}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {welcomeSummary.offerRedemption?.note || 'No redemption events'}
              </div>
            </div>
          </div>

          {/* Excluded & Skipped Breakdowns */}
          {(Object.keys(welcomeSummary.excludedByReason || {}).length > 0 ||
            Object.keys(welcomeSummary.skippedByReason || {}).length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 4 }}>
              {Object.keys(welcomeSummary.excludedByReason || {}).length > 0 && (
                <div style={{ padding: 14, borderRadius: 8, background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                    Excluded Reasons (Eligibility Gates)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(welcomeSummary.excludedByReason).map(([reason, cnt]) => (
                      <span
                        key={reason}
                        style={{
                          fontSize: '0.75rem',
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.25)',
                          color: '#fca5a5',
                        }}
                      >
                        {reason}: {cnt as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {Object.keys(welcomeSummary.skippedByReason || {}).length > 0 && (
                <div style={{ padding: 14, borderRadius: 8, background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                    Skipped Reasons (Worker Recheck / Timing)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(welcomeSummary.skippedByReason).map(([reason, cnt]) => (
                      <span
                        key={reason}
                        style={{
                          fontSize: '0.75rem',
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(245, 158, 11, 0.1)',
                          border: '1px solid rgba(245, 158, 11, 0.25)',
                          color: '#fde68a',
                        }}
                      >
                        {reason}: {cnt as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Repeat Purchase Bring-Back Specific Summary (F20) */}
      {repeatSummary && (
        <div
          className="glass-panel"
          style={{
            padding: 24,
            border: '1px solid rgba(16, 185, 129, 0.35)',
            background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.05) 0%, rgba(6, 182, 212, 0.03) 100%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--accent-emerald)',
                }}
              >
                <ShoppingBag size={18} />
              </div>
              <span className="badge badge-emerald">Repeat Purchase Bring-Back Summary (F20)</span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                First-to-Second Purchase Delay Pipeline &bull; Event-Driven Nudges
              </span>
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                background: 'rgba(255, 255, 255, 0.04)',
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-color)',
              }}
            >
              {repeatSummary.note || 'Observational metrics only \u2022 NOT sales attribution'}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 14,
            }}
          >
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>First Orders Enrolled</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {repeatSummary.enrollments?.total || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-cyan)', marginTop: 2 }}>
                {repeatSummary.enrollments?.active || 0} active &bull; {repeatSummary.enrollments?.excluded || 0} excluded
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Scheduled / Deferred</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {(repeatSummary.executions?.scheduled || 0) + (repeatSummary.executions?.deferred || 0)}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-amber)', marginTop: 2 }}>
                {repeatSummary.executions?.scheduled || 0} scheduled &bull; {repeatSummary.executions?.deferred || 0} deferred
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Delivered & Read</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {repeatSummary.executions?.delivered || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-emerald)', marginTop: 2 }}>
                {repeatSummary.executions?.read || 0} confirmed read
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Skipped Executions</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {repeatSummary.executions?.skipped || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Evaluated and safely skipped
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Replies & Holds</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {repeatSummary.repliesAndHolds?.totalHeldOrReplied || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-rose)', marginTop: 2 }}>
                {repeatSummary.repliesAndHolds?.exactCampaignReplies || 0} exact &bull; {repeatSummary.repliesAndHolds?.currentlyOnHold || 0} held
              </div>
            </div>
          </div>

          {/* Excluded & Skipped Breakdowns */}
          {(Object.keys(repeatSummary.enrollments?.excludedByReason || {}).length > 0 ||
            Object.keys(repeatSummary.executions?.skippedByReason || {}).length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 4 }}>
              {Object.keys(repeatSummary.enrollments?.excludedByReason || {}).length > 0 && (
                <div style={{ padding: 14, borderRadius: 8, background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                    Excluded Reasons (Eligibility Gates)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(repeatSummary.enrollments.excludedByReason).map(([reason, cnt]) => (
                      <span
                        key={reason}
                        style={{
                          fontSize: '0.75rem',
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.25)',
                          color: '#fca5a5',
                        }}
                      >
                        {reason}: {cnt as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {Object.keys(repeatSummary.executions?.skippedByReason || {}).length > 0 && (
                <div style={{ padding: 14, borderRadius: 8, background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                    Skipped Reasons (Safety Gates & Stops)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(repeatSummary.executions.skippedByReason).map(([reason, cnt]) => (
                      <span
                        key={reason}
                        style={{
                          fontSize: '0.75rem',
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(245, 158, 11, 0.1)',
                          border: '1px solid rgba(245, 158, 11, 0.25)',
                          color: '#fde68a',
                        }}
                      >
                        {reason}: {cnt as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Occasion Reminders Summary Banner (Spec F22, Gift / Wedding) */}
      {occasionSummary && (
        <div
          className="glass-panel"
          style={{
            padding: 24,
            background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.08), rgba(245, 158, 11, 0.05))',
            border: '1px solid rgba(168, 85, 247, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Gift size={20} color="#c084fc" />
              <div>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                  Occasion Reminders Observational Summary &bull; {occasionSummary.occasionKind}
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Lead Time: {occasionSummary.fulfillmentLeadDays} Days &bull; Generated: {new Date(occasionSummary.generatedAt).toLocaleTimeString()}
                </span>
              </div>
            </div>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '4px 10px',
                borderRadius: 6,
                background: 'rgba(168, 85, 247, 0.15)',
                color: '#c084fc',
                border: '1px solid rgba(168, 85, 247, 0.3)',
              }}
            >
              F22 Occasion Engine
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 12,
            }}
          >
            <div style={{ padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>In Horizon Window</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {occasionSummary.occasionsInWindow ?? 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {occasionSummary.occasionsBeyondHorizon ?? 0} beyond horizon
              </div>
            </div>

            <div style={{ padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Eligible Enrolled</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-emerald)', marginTop: 4 }}>
                {occasionSummary.eligibleEnrollments ?? 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Active candidate occasions
              </div>
            </div>

            <div style={{ padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Lead-Time Skips</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-amber)', marginTop: 4 }}>
                {occasionSummary.leadTimeSkips ?? 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Elapsed fulfillment deadline
              </div>
            </div>

            <div style={{ padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Replanned (CAS)</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-cyan)', marginTop: 4 }}>
                {occasionSummary.replansCount ?? 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Rescheduled date updates
              </div>
            </div>

            <div style={{ padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Completions</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#38bdf8', marginTop: 4 }}>
                {occasionSummary.completions?.total ?? 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {occasionSummary.completions?.orderTagged ?? 0} tagged order &bull; {occasionSummary.completions?.staffCompleted ?? 0} staff
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Complete the Outfit Specific Summary (F24) */}
      {outfitSummary && (
        <div
          className="glass-panel"
          style={{
            padding: 24,
            border: '1px solid rgba(139, 92, 246, 0.35)',
            background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.06) 0%, rgba(236, 72, 153, 0.04) 100%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
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
                  color: 'var(--accent-purple, #a855f7)',
                }}
              >
                <Sparkles size={18} />
              </div>
              <div>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                  Complete the Outfit Summary (F24)
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Observational window: {outfitSummary.observationalWindowDays || 14} days &bull; Deterministic pairing matching
                </span>
              </div>
            </div>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '4px 10px',
                borderRadius: 6,
                background: 'rgba(139, 92, 246, 0.15)',
                color: '#c084fc',
                border: '1px solid rgba(139, 92, 246, 0.3)',
              }}
            >
              F24 Outfit Presets
            </span>
          </div>

          {/* Metrics Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 12,
            }}
          >
            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Eligible Orders</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {outfitSummary.eligibleOrdersCount || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                Orders in anchor categories
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Enrolled Outfits</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-indigo)', marginTop: 4 }}>
                {outfitSummary.enrolledCount || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                Active candidate occurrences
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Scheduled / Sent</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {(outfitSummary.scheduledExecutionsCount || 0) + (outfitSummary.sentExecutionsCount || 0)}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-amber)', marginTop: 2 }}>
                {outfitSummary.scheduledExecutionsCount || 0} due &bull; {outfitSummary.sentExecutionsCount || 0} sent
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Delivered & Read</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', marginTop: 4 }}>
                {outfitSummary.deliveredCount || 0}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-emerald)', marginTop: 2 }}>
                {outfitSummary.readCount || 0} confirmed read
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Observational Purchases</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-emerald)', marginTop: 4 }}>
                {outfitSummary.observationalPurchasesCount || 0}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 2, fontStyle: 'italic' }}>
                ₹{((outfitSummary.observationalRevenuePaise || 0) / 100).toLocaleString('en-IN')} &bull; Customers who bought a complement after the message; observational only, not sales attribution (spec p28)
              </div>
            </div>
          </div>

          {/* Excluded & Skipped Breakdowns */}
          {(Object.keys(outfitSummary.excludedByReason || {}).length > 0 ||
            Object.keys(outfitSummary.skippedByReason || {}).length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 4 }}>
              {Object.keys(outfitSummary.excludedByReason || {}).length > 0 && (
                <div style={{ padding: 14, borderRadius: 8, background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                    Excluded Reasons (Eligibility Gates)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(outfitSummary.excludedByReason).map(([reason, cnt]) => (
                      <span
                        key={reason}
                        style={{
                          fontSize: '0.75rem',
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.25)',
                          color: '#fca5a5',
                        }}
                      >
                        {reason}: {cnt as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {Object.keys(outfitSummary.skippedByReason || {}).length > 0 && (
                <div style={{ padding: 14, borderRadius: 8, background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                    Skipped Reasons (Safety Gates & Stockout Checks)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(outfitSummary.skippedByReason).map(([reason, cnt]) => (
                      <span
                        key={reason}
                        style={{
                          fontSize: '0.75rem',
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(245, 158, 11, 0.1)',
                          border: '1px solid rgba(245, 158, 11, 0.25)',
                          color: '#fde68a',
                        }}
                      >
                        {reason}: {cnt as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 8 Core Metrics Grid (Spec p28) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 16,
        }}
      >
        {/* 1. Eligible Customers */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid var(--accent-indigo)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Eligible Customers
              </span>
              <Users size={16} color="var(--accent-indigo)" />
            </div>
            <div style={{ fontSize: '1.85rem', fontWeight: 800, color: '#fff', marginTop: 8 }}>
              {report.eligible.count}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: '0.725rem', color: 'var(--text-muted)' }}>
            {report.eligible.statedAt ? (
              <span>Evaluated: {new Date(report.eligible.statedAt).toLocaleDateString()}</span>
            ) : (
              <span>Awaiting dry run evaluation</span>
            )}
            <div style={{ color: 'var(--text-muted)', fontSize: '0.675rem', marginTop: 2 }}>
              Changing estimate, not guaranteed send
            </div>
          </div>
        </div>

        {/* 2. Enrollments */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid var(--accent-cyan)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Total Enrollments
              </span>
              <Calendar size={16} color="var(--accent-cyan)" />
            </div>
            <div style={{ fontSize: '1.85rem', fontWeight: 800, color: '#fff', marginTop: 8 }}>
              {report.enrollments.total}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: '0.725rem', color: '#a5f3fc' }}>
            <span>{report.enrollments.uniqueCustomers} unique customers</span>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.675rem', marginTop: 2 }}>
              Multiple steps do not multiply count
            </div>
          </div>
        </div>

        {/* 3. Scheduled & Deferred */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid #38bdf8',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Pending Executions
              </span>
              <Clock size={16} color="#38bdf8" />
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
              <span style={{ fontSize: '1.85rem', fontWeight: 800, color: '#fff' }}>
                {report.executionCounts.scheduled}
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                ({report.executionCounts.deferred} deferred)
              </span>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: '0.725rem', color: '#bae6fd' }}>
            {report.executionCounts.nextScheduledDueAt ? (
              <span>Next: {new Date(report.executionCounts.nextScheduledDueAt).toLocaleString()}</span>
            ) : (
              <span>No pending scheduled steps</span>
            )}
          </div>
        </div>

        {/* 4. Business Stops (Skipped / Cancelled / Expired) */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid var(--accent-amber)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Business Stops
              </span>
              <AlertTriangle size={16} color="var(--accent-amber)" />
            </div>
            <div style={{ fontSize: '1.85rem', fontWeight: 800, color: '#fff', marginTop: 8 }}>
              {report.executionCounts.skipped + report.executionCounts.cancelled + report.executionCounts.expired}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: '0.725rem', color: '#fde68a' }}>
            <span>
              {report.executionCounts.skipped} skipped &bull; {report.executionCounts.cancelled} cancelled &bull; {report.executionCounts.expired} expired
            </span>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.675rem', marginTop: 2 }}>
              Business rules, not provider failures
            </div>
          </div>
        </div>

        {/* 5. WhatsApp Delivery Evidence */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid var(--accent-emerald)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Delivery Evidence
              </span>
              <CheckCircle2 size={16} color="var(--accent-emerald)" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 10 }}>
              <div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Accepted</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#10b981' }}>
                  {report.deliveryEvidence.accepted}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Delivered</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#34d399' }}>
                  {report.deliveryEvidence.delivered}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Read</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#a78bfa' }}>
                  {report.deliveryEvidence.read}
                </div>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: '0.675rem', color: '#a7f3d0' }}>
            Accepted is not delivered; delivered is not a sale
          </div>
        </div>

        {/* 6. Inbound Replies & Holds */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid #f59e0b',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Inbound Replies & Holds
              </span>
              <MessageCircle size={16} color="#fbbf24" />
            </div>
            <div style={{ fontSize: '1.85rem', fontWeight: 800, color: '#fff', marginTop: 8 }}>
              {report.repliesAndHolds.totalHeldOrReplied}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: '0.725rem', color: '#fde68a' }}>
            <span>
              {report.repliesAndHolds.exactCampaignReplies} exact reply &bull; {report.repliesAndHolds.conservativeHolds} conservative
            </span>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.675rem', marginTop: 2 }}>
              {report.repliesAndHolds.currentlyOnHold} active holds ({report.repliesAndHolds.resolvedHolds} resolved)
            </div>
          </div>
        </div>

        {/* 7. Goal Completions */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid #a855f7',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Goal Completions
              </span>
              <Target size={16} color="#c084fc" />
            </div>
            <div style={{ fontSize: '1.85rem', fontWeight: 800, color: '#fff', marginTop: 8 }}>
              {report.goalCompletions.total}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: '0.725rem', color: '#e9d5ff' }}>
            <span>
              {report.goalCompletions.orderOccasion} tagged purchase &bull; {report.goalCompletions.staffManual} staff confirmed
            </span>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.675rem', marginTop: 2 }}>
              Delivery alone never creates a goal
            </div>
          </div>
        </div>

        {/* 8. Attributed Orders & Net Sales (Spec p28) */}
        <div
          className="glass-panel"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            borderLeft: '4px solid #10b981',
            background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08), rgba(6, 182, 212, 0.05))',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-emerald)', textTransform: 'uppercase' }}>
                Attributed Net Sales
              </span>
              <DollarSign size={16} color="var(--accent-emerald)" />
            </div>
            <div style={{ fontSize: '1.85rem', fontWeight: 900, color: '#fff', marginTop: 8 }}>
              ₹{report.attribution.totalNetSalesRupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: '0.725rem', color: '#a7f3d0' }}>
            <span>{report.attribution.orderCount} attributed orders ({report.attribution.refundsCount} refunds/returns)</span>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.675rem', marginTop: 2 }}>
              Explicit occasionRef & goal links only
            </div>
          </div>
        </div>
      </div>

      {/* Honest Boundary & Single Attribution Notice */}
      <div
        className="glass-panel"
        style={{
          padding: '14px 18px',
          background: 'rgba(56, 189, 248, 0.06)',
          borderColor: 'rgba(56, 189, 248, 0.25)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: '0.8rem',
          color: '#bae6fd',
        }}
      >
        <ShieldCheck size={20} color="var(--accent-cyan)" style={{ flexShrink: 0 }} />
        <div>
          <strong style={{ color: '#fff' }}>Single Attribution Policy (Spec p28):</strong> Each order is attributed to at most
          one campaign by explicit evidence (tagged <code>occasionRef</code> or durable goal event). Delivery alone is never
          assumed to be a sale. Store orders without campaign links (<strong>{report.unassignedStoreOrders.orderCount} orders &bull; ₹{report.unassignedStoreOrders.netSalesRupees.toFixed(2)}</strong>) are reported separately.
        </div>
      </div>

      {/* Step Funnel Section */}
      <div className="glass-panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h4 style={{ fontSize: '1rem', fontWeight: 800, color: '#fff', margin: 0 }}>
              Step Progression Funnel
            </h4>
            <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
              Execution outcomes at each step in the campaign lifecycle
            </p>
          </div>
          {onViewActivity && (
            <button onClick={onViewActivity} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.75rem' }}>
              View Activity List <ArrowRight size={13} />
            </button>
          )}
        </div>

        {report.stepFunnel.length === 0 ? (
          <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            No executions planned yet. Run the Calendar Planner to fit steps for eligible occasions.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            {report.stepFunnel.map((step, idx) => (
              <div
                key={step.stepId}
                style={{
                  padding: 18,
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        background: 'rgba(99, 102, 241, 0.2)',
                        color: 'var(--accent-cyan)',
                        fontSize: '0.75rem',
                        fontWeight: 800,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <strong style={{ color: '#fff', fontSize: '0.9rem' }}>{step.stepName}</strong>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {step.stepId}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: '0.75rem' }}>
                  <div style={{ padding: '8px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 6 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Scheduled:</span>{' '}
                    <strong style={{ color: '#fff' }}>{step.scheduled}</strong>
                  </div>
                  <div style={{ padding: '8px', background: 'rgba(16, 185, 129, 0.08)', borderRadius: 6 }}>
                    <span style={{ color: '#34d399' }}>Accepted:</span>{' '}
                    <strong style={{ color: '#10b981' }}>{step.accepted}</strong>
                  </div>
                  <div style={{ padding: '8px', background: 'rgba(52, 211, 153, 0.08)', borderRadius: 6 }}>
                    <span style={{ color: '#6ee7b7' }}>Delivered:</span>{' '}
                    <strong style={{ color: '#34d399' }}>{step.delivered}</strong>
                  </div>
                  <div style={{ padding: '8px', background: 'rgba(167, 139, 250, 0.08)', borderRadius: 6 }}>
                    <span style={{ color: '#a78bfa' }}>Read:</span>{' '}
                    <strong style={{ color: '#c4b5fd' }}>{step.read}</strong>
                  </div>
                  <div style={{ padding: '8px', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 6 }}>
                    <span style={{ color: '#fbbf24' }}>Skipped:</span>{' '}
                    <strong style={{ color: '#fde68a' }}>{step.skipped}</strong>
                  </div>
                  <div style={{ padding: '8px', background: 'rgba(244, 63, 94, 0.08)', borderRadius: 6 }}>
                    <span style={{ color: '#fb7185' }}>Cancelled:</span>{' '}
                    <strong style={{ color: '#fda4af' }}>{step.cancelled}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Skipped Reason Breakdown Section (Spec p28, p29: "visible to owners") */}
      <div className="glass-panel" style={{ padding: 24 }}>
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ fontSize: '1rem', fontWeight: 800, color: '#fff', margin: 0 }}>
            Skipped & Business-Stop Reason Breakdown
          </h4>
          <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
            Spec p29: Missing customer data, date rules, and capacity limits are made visible to owners
          </p>
        </div>

        {report.executionCounts.primaryReasons.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            No executions were skipped or stopped by business rules.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {report.executionCounts.primaryReasons.map((item, idx) => {
              const isSkipped = item.category === 'SKIPPED';
              const isCancelled = item.category === 'CANCELLED';
              const isExpired = item.category === 'EXPIRED';

              const badgeColor = isSkipped ? '#fbbf24' : isCancelled ? '#fb7185' : '#94a3b8';
              const badgeBg = isSkipped
                ? 'rgba(245, 158, 11, 0.15)'
                : isCancelled
                ? 'rgba(244, 63, 94, 0.15)'
                : 'rgba(148, 163, 184, 0.15)';

              return (
                <div
                  key={`${item.category}-${item.reason}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        fontSize: '0.675rem',
                        fontWeight: 800,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: badgeBg,
                        color: badgeColor,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {item.category}
                    </span>
                    <span style={{ fontSize: '0.85rem', color: '#fff' }}>{item.reason}</span>
                  </div>
                  <strong style={{ fontSize: '0.9rem', color: '#fff', fontFamily: 'var(--font-mono)' }}>
                    {item.count}
                  </strong>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Attributed Orders Breakdown Table */}
      <div className="glass-panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h4 style={{ fontSize: '1rem', fontWeight: 800, color: '#fff', margin: 0 }}>
              Explicitly Linked Orders ({report.attribution.orders.length})
            </h4>
            <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
              Orders linked by occasionRef or goal evidence contributing to net sales
            </p>
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--accent-emerald)', fontWeight: 800 }}>
            Net Total: ₹{report.attribution.totalNetSalesRupees.toFixed(2)}
          </div>
        </div>

        {report.attribution.orders.length === 0 ? (
          <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            No linked orders yet. Delivered messages with no order evidence report zero sales (QA Matrix C17).
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.825rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '10px 12px' }}>Order ID</th>
                  <th style={{ padding: '10px 12px' }}>Customer ID</th>
                  <th style={{ padding: '10px 12px' }}>Occasion Ref</th>
                  <th style={{ padding: '10px 12px' }}>Attribution Source</th>
                  <th style={{ padding: '10px 12px' }}>Status</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>Net Amount (INR)</th>
                </tr>
              </thead>
              <tbody>
                {report.attribution.orders.map((o) => (
                  <tr
                    key={o.orderId}
                    style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)', color: '#fff' }}
                  >
                    <td style={{ padding: '12px', fontFamily: 'var(--font-mono)' }}>
                      <strong>{o.orderId}</strong>
                    </td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)' }}>{o.customerId}</td>
                    <td style={{ padding: '12px', color: 'var(--accent-cyan)' }}>{o.occasionRef || 'None'}</td>
                    <td style={{ padding: '12px' }}>
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: 'rgba(99, 102, 241, 0.15)',
                          color: 'var(--accent-indigo)',
                        }}
                      >
                        {o.attributionSource}
                      </span>
                    </td>
                    <td style={{ padding: '12px' }}>
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background:
                            o.status === 'COMPLETED'
                              ? 'rgba(16, 185, 129, 0.2)'
                              : 'rgba(239, 68, 68, 0.2)',
                          color: o.status === 'COMPLETED' ? '#34d399' : '#f87171',
                        }}
                      >
                        {o.status}
                      </span>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: 800 }}>
                      ₹{o.netRupees.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

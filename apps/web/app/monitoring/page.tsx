'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useAuth } from '../../context/AuthContext';
import {
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Play,
  Trash2,
  Gauge,
  HelpCircle,
  Inbox,
  Lock,
  Layers,
  Sparkles,
  BarChart3,
  Calendar,
  AlertOctagon,
} from 'lucide-react';
import { OperationalMetrics, ReconciliationResult } from '@grovastra/shared';

export default function MonitoringPage() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<OperationalMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningReconciliation, setRunningReconciliation] = useState(false);
  const [runningRetention, setRunningRetention] = useState(false);
  const [reconciliationResult, setReconciliationResult] = useState<ReconciliationResult | null>(null);
  const [retentionMessage, setRetentionMessage] = useState<string | null>(null);

  const fetchMetrics = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/v1/monitoring/operational-metrics');
      if (!res.ok) {
        throw new Error(`Failed to load operational metrics: HTTP ${res.status}`);
      }
      const data = await res.json();
      setMetrics(data);
    } catch (err: any) {
      setError(err.message || 'Error fetching metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
  }, []);

  const handleRunReconciliation = async () => {
    try {
      setRunningReconciliation(true);
      const res = await fetch('/api/v1/monitoring/reconciliation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Failed to run reconciliation');
      const data = await res.json();
      setReconciliationResult(data);
      await fetchMetrics();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunningReconciliation(false);
    }
  };

  const handleRunRetention = async () => {
    try {
      setRunningRetention(true);
      const res = await fetch('/api/v1/monitoring/retention/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoffDays: 90, retentionReason: 'DATA_RETENTION_PRUNING' }),
      });
      if (!res.ok) throw new Error('Failed to run retention pruning');
      const data = await res.json();
      setRetentionMessage(
        `Pruned ${data.prunedEnrollmentsCount} enrollments & ${data.prunedExecutionsCount} executions. Created ${data.tombstonesCreatedCount} logical-key tombstones.`
      );
      await fetchMetrics();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunningRetention(false);
    }
  };

  return (
    <AppShell activeTab="monitoring">
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
        {/* Top Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 28,
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              <h1
                style={{
                  fontSize: '1.75rem',
                  fontWeight: 700,
                  color: 'var(--text-primary, #0f172a)',
                  margin: 0,
                }}
              >
                Operational Safeguards & Monitoring
              </h1>
              {metrics && (
                <span
                  id="badge-health-status"
                  style={{
                    padding: '4px 10px',
                    borderRadius: 20,
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    background:
                      metrics.healthStatus === 'HEALTHY'
                        ? 'rgba(16, 185, 129, 0.15)'
                        : metrics.healthStatus === 'DEGRADED'
                        ? 'rgba(245, 158, 11, 0.15)'
                        : 'rgba(239, 68, 68, 0.15)',
                    color:
                      metrics.healthStatus === 'HEALTHY'
                        ? '#059669'
                        : metrics.healthStatus === 'DEGRADED'
                        ? '#d97706'
                        : '#dc2626',
                    border: `1px solid ${
                      metrics.healthStatus === 'HEALTHY'
                        ? 'rgba(16, 185, 129, 0.3)'
                        : metrics.healthStatus === 'DEGRADED'
                        ? 'rgba(245, 158, 11, 0.3)'
                        : 'rgba(239, 68, 68, 0.3)'
                    }`,
                  }}
                >
                  {metrics.healthStatus}
                </span>
              )}
            </div>
            <p style={{ margin: 0, color: 'var(--text-secondary, #64748b)', fontSize: '0.9rem' }}>
              Spec p18, p25, p34 automated health verification: planner lag, due-step age, reason counts,
              event backlog, and bounded reconciliation.
            </p>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              id="btn-refresh-monitoring"
              onClick={fetchMetrics}
              disabled={loading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 8,
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
                fontWeight: 600,
                color: '#334155',
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>

            <button
              id="btn-run-reconciliation"
              onClick={handleRunReconciliation}
              disabled={runningReconciliation}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 8,
                background: 'linear-gradient(135deg, #4f46e5, #6366f1)',
                border: 'none',
                color: '#ffffff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: runningReconciliation ? 'not-allowed' : 'pointer',
                boxShadow: '0 2px 4px rgba(79, 70, 229, 0.2)',
              }}
            >
              <Play size={14} />
              {runningReconciliation ? 'Reconciling...' : 'Run Nightly Reconciliation'}
            </button>

            <button
              id="btn-run-retention"
              onClick={handleRunRetention}
              disabled={runningRetention}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 8,
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
                fontWeight: 600,
                color: '#475569',
                cursor: runningRetention ? 'not-allowed' : 'pointer',
              }}
            >
              <Trash2 size={14} />
              {runningRetention ? 'Pruning...' : 'Prune (Tombstones)'}
            </button>
          </div>
        </div>

        {/* Alerts Banner */}
        {metrics && metrics.alerts.length > 0 && (
          <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {metrics.alerts.map((alert, idx) => (
              <div
                key={idx}
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background:
                    alert.severity === 'CRITICAL'
                      ? 'rgba(239, 68, 68, 0.08)'
                      : alert.severity === 'WARNING'
                      ? 'rgba(245, 158, 11, 0.08)'
                      : 'rgba(59, 130, 246, 0.08)',
                  border: `1px solid ${
                    alert.severity === 'CRITICAL'
                      ? 'rgba(239, 68, 68, 0.3)'
                      : alert.severity === 'WARNING'
                      ? 'rgba(245, 158, 11, 0.3)'
                      : 'rgba(59, 130, 246, 0.3)'
                  }`,
                }}
              >
                {alert.severity === 'CRITICAL' ? (
                  <AlertOctagon size={18} color="#dc2626" />
                ) : alert.severity === 'WARNING' ? (
                  <AlertTriangle size={18} color="#d97706" />
                ) : (
                  <HelpCircle size={18} color="#2563eb" />
                )}
                <div style={{ fontSize: '0.85rem' }}>
                  <strong style={{ color: '#0f172a' }}>[{alert.component}]</strong>{' '}
                  <span style={{ color: '#334155' }}>{alert.message}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Reconciliation Success Feedback */}
        {reconciliationResult && (
          <div
            id="reconciliation-result-banner"
            style={{
              padding: '16px 20px',
              borderRadius: 8,
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              marginBottom: 24,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <CheckCircle2 size={16} color="#16a34a" />
              <strong style={{ color: '#166534', fontSize: '0.9rem' }}>
                Reconciliation Cycle Completed ({reconciliationResult.durationMs}ms)
              </strong>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 12,
                fontSize: '0.8rem',
                color: '#15803d',
                marginTop: 8,
              }}
            >
              <div>Stalled Leases Released: {reconciliationResult.counts.stalledLeasesReleased}</div>
              <div>Orphaned Intents Cleaned: {reconciliationResult.counts.orphanedIntentsCleaned}</div>
              <div>Expired Steps Marked: {reconciliationResult.counts.expiredStepsMarked}</div>
              <div>Missed Events Processed: {reconciliationResult.counts.missedEventsProcessed}</div>
            </div>
          </div>
        )}

        {/* Retention Success Feedback */}
        {retentionMessage && (
          <div
            id="retention-result-banner"
            style={{
              padding: '12px 16px',
              borderRadius: 8,
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              marginBottom: 24,
              fontSize: '0.85rem',
              color: '#334155',
            }}
          >
            <strong>Data Retention Pruning:</strong> {retentionMessage}
          </div>
        )}

        {/* 7 Core Operational Safeguard Cards */}
        {metrics && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 20,
              marginBottom: 32,
            }}
          >
            {/* 1. Planner Lag */}
            <div
              id="card-planner-lag"
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                  Planner Lag (Spec p34)
                </span>
                <Clock size={16} color="#6366f1" />
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {metrics.plannerLag.maxLagFormatted}
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
                {metrics.plannerLag.overdueCampaignsCount === 0
                  ? 'All active campaigns planned on schedule'
                  : `${metrics.plannerLag.overdueCampaignsCount} campaign(s) overdue for next evaluation`}
              </p>
            </div>

            {/* 2. Due-Step Age */}
            <div
              id="card-due-step-age"
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                  Due-Step Age (Spec p34)
                </span>
                <Gauge size={16} color="#10b981" />
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {metrics.dueStepAge.maxAgeFormatted}
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
                {metrics.dueStepAge.dueStepCount} step(s) waiting for worker dispatch (avg age:{' '}
                {Math.round(metrics.dueStepAge.avgAgeMs / 1000)}s)
              </p>
            </div>

            {/* 3. Event Backlog */}
            <div
              id="card-event-backlog"
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                  Domain Event Backlog
                </span>
                <Inbox size={16} color="#3b82f6" />
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {metrics.eventBacklog.pendingCount}
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
                Pending inbox events ({metrics.eventBacklog.quarantinedCount} quarantined in dead-letter)
              </p>
            </div>

            {/* 4. Unknown Send Outcomes */}
            <div
              id="card-outcome-unknown"
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                  Outcome Unknown (C06/C07)
                </span>
                <HelpCircle size={16} color="#eab308" />
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {metrics.outcomeUnknownCount}
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
                Executions awaiting webhook confirmation (no automatic resends)
              </p>
            </div>

            {/* 5. Template Blocks */}
            <div
              id="card-template-blocks"
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                  Template Blocks (C02/C19)
                </span>
                <Lock size={16} color="#ec4899" />
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {metrics.templateBlocks.blockedExecutionsCount}
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
                Blocked across {metrics.templateBlocks.affectedCampaigns.length} campaign(s) (rechecked on edit)
              </p>
            </div>

            {/* 6. Stalled Checkpoints */}
            <div
              id="card-stalled-checkpoints"
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                  Stalled Checkpoints
                </span>
                <AlertTriangle size={16} color="#f97316" />
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {metrics.stalledCheckpoints.length}
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
                {metrics.stalledCheckpoints.length === 0
                  ? 'All distributed leases active or released'
                  : 'Stalled leases automatically cleared by nightly reconciliation'}
              </p>
            </div>

            {/* 7. Tenant-Fair Processing */}
            <div
              id="card-tenant-fair-share"
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                  Fair Processing (Spec p18)
                </span>
                <Layers size={16} color="#8b5cf6" />
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {metrics.tenantFairProcessing.fairShareIndex}%
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
                {metrics.tenantFairProcessing.activeReservations} in-flight destination reservations (
                {metrics.tenantFairProcessing.rolling24hContacts} contacts past 24h)
              </p>
            </div>
          </div>
        )}

        {/* Skipped Reasons Breakdown Table */}
        {metrics && (
          <div
            style={{
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              padding: '24px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <BarChart3 size={20} color="#6366f1" />
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
                Skipped & Stopped Reason Breakdown (Spec p28, p34)
              </h2>
            </div>
            <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: 20 }}>
              Primary business reasons why campaign steps were stopped, deferred, or skipped. Fully visible to
              boutique owners to highlight missing data or contact limits.
            </p>

            {metrics.skippedReasons.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: '#94a3b8', fontStyle: 'italic' }}>
                No executions have been skipped or stopped for this tenant yet.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left', color: '#64748b' }}>
                      <th style={{ padding: '10px 12px' }}>Reason / Cause</th>
                      <th style={{ padding: '10px 12px' }}>Count</th>
                      <th style={{ padding: '10px 12px' }}>Percentage</th>
                      <th style={{ padding: '10px 12px' }}>Visual Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.skippedReasons.map((r, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '12px', fontWeight: 600, color: '#334155' }}>{r.reason}</td>
                        <td style={{ padding: '12px', color: '#0f172a' }}>{r.count}</td>
                        <td style={{ padding: '12px', color: '#64748b' }}>{r.percentage}%</td>
                        <td style={{ padding: '12px', minWidth: 160 }}>
                          <div
                            style={{
                              width: '100%',
                              height: 8,
                              borderRadius: 4,
                              background: '#f1f5f9',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.min(100, r.percentage)}%`,
                                height: '100%',
                                background: 'linear-gradient(90deg, #6366f1, #818cf8)',
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

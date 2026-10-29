'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useAuth } from '../../context/AuthContext';
import {
  Activity,
  RefreshCw,
  ShieldCheck,
  Clock,
  User,
  Globe,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  ShieldAlert,
  Eye,
  X,
  Layers,
} from 'lucide-react';

interface AuditLogEntry {
  _id?: string;
  tenantId: string;
  userId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt: string;
}

export default function ActivityPage() {
  const { user, tenant } = useAuth();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Tabs: 'audit' | 'quarantine' (Spec p24, p29)
  const [activeTab, setActiveTab] = useState<'audit' | 'quarantine'>('audit');
  const [quarantinedEvents, setQuarantinedEvents] = useState<any[]>([]);
  const [quarantinedTotal, setQuarantinedTotal] = useState(0);
  const [quarantinedLoading, setQuarantinedLoading] = useState(false);
  const [selectedQuarantineItem, setSelectedQuarantineItem] = useState<any | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      setRefreshing(true);
      const res = await fetch('/api/tenant/activity?limit=50', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch {
      // Graceful error handling
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchQuarantined = useCallback(async () => {
    try {
      setQuarantinedLoading(true);
      const res = await fetch('/api/internal/campaign-events/quarantine?limit=50', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setQuarantinedEvents(data.events || []);
        setQuarantinedTotal(data.total || 0);
      }
    } catch {
      // Graceful error handling
    } finally {
      setQuarantinedLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    fetchQuarantined();
  }, [fetchLogs, fetchQuarantined]);

  const getActionBadge = (action: string) => {
    if (action.includes('login_success')) {
      return (
        <span
          style={{
            background: 'rgba(16, 185, 129, 0.15)',
            color: '#34d399',
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 700,
            border: '1px solid rgba(16, 185, 129, 0.3)',
          }}
        >
          Login Success
        </span>
      );
    }
    if (action.includes('login_failed')) {
      return (
        <span
          style={{
            background: 'rgba(244, 63, 94, 0.15)',
            color: '#fb7185',
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 700,
            border: '1px solid rgba(244, 63, 94, 0.3)',
          }}
        >
          Login Failed
        </span>
      );
    }
    if (action.includes('role_changed')) {
      return (
        <span
          style={{
            background: 'rgba(245, 158, 11, 0.15)',
            color: '#fbbf24',
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 700,
            border: '1px solid rgba(245, 158, 11, 0.3)',
          }}
        >
          Role Changed
        </span>
      );
    }
    if (action.includes('seed')) {
      return (
        <span
          style={{
            background: 'rgba(99, 102, 241, 0.15)',
            color: '#818cf8',
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 700,
            border: '1px solid rgba(99, 102, 241, 0.3)',
          }}
        >
          Seed Initial Data
        </span>
      );
    }
    if (action.includes('occasion.saved') || action.includes('occasion_saved')) {
      return (
        <span
          style={{
            background: 'rgba(56, 189, 248, 0.15)',
            color: '#38bdf8',
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 700,
            border: '1px solid rgba(56, 189, 248, 0.3)',
          }}
        >
          Occasion Saved
        </span>
      );
    }
    if (action.includes('occasion.cancelled') || action.includes('occasion_cancelled')) {
      return (
        <span
          style={{
            background: 'rgba(244, 63, 94, 0.15)',
            color: '#fb7185',
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 700,
            border: '1px solid rgba(244, 63, 94, 0.3)',
          }}
        >
          Occasion Cancelled
        </span>
      );
    }
    if (action.includes('occasion.completed') || action.includes('occasion_completed')) {
      return (
        <span
          style={{
            background: 'rgba(16, 185, 129, 0.15)',
            color: '#34d399',
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 700,
            border: '1px solid rgba(16, 185, 129, 0.3)',
          }}
        >
          Occasion Completed
        </span>
      );
    }
    return (
      <span
        style={{
          background: 'rgba(255, 255, 255, 0.08)',
          color: 'var(--text-secondary)',
          padding: '3px 8px',
          borderRadius: 6,
          fontSize: '0.75rem',
          fontWeight: 600,
        }}
      >
        {action}
      </span>
    );
  };

  return (
    <AppShell activeTab="activity">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--accent-emerald)',
                }}
              >
                Immutable Governance &amp; Event Stream
              </span>
              <span className="badge badge-staff">All Roles Access</span>
            </div>
            <h2 style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', margin: 0 }}>
              Tenant Activity &amp; Audit Trail
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: 4 }}>
              Strictly append-only log of security, authentication, and domain event quarantine for{' '}
              <strong>{tenant?.name}</strong>.
            </p>
          </div>

          <button
            onClick={() => {
              fetchLogs();
              fetchQuarantined();
            }}
            disabled={refreshing || quarantinedLoading}
            className="btn btn-secondary"
            style={{ padding: '8px 16px' }}
          >
            <RefreshCw size={14} className={refreshing || quarantinedLoading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', gap: 12, borderBottom: '1px solid var(--border-color)', paddingBottom: 10 }}>
          <button
            type="button"
            onClick={() => setActiveTab('audit')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: '0.875rem',
              fontWeight: 700,
              color: activeTab === 'audit' ? '#fff' : 'var(--text-muted)',
              backgroundColor: activeTab === 'audit' ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
              borderBottom: activeTab === 'audit' ? '2px solid var(--accent-indigo)' : '2px solid transparent',
            }}
          >
            <ShieldCheck size={16} color={activeTab === 'audit' ? 'var(--accent-indigo)' : 'currentColor'} />
            Security Audit Trail ({logs.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('quarantine')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: '0.875rem',
              fontWeight: 700,
              color: activeTab === 'quarantine' ? 'var(--accent-amber)' : 'var(--text-muted)',
              backgroundColor: activeTab === 'quarantine' ? 'rgba(245, 158, 11, 0.15)' : 'transparent',
              borderBottom: activeTab === 'quarantine' ? '2px solid var(--accent-amber)' : '2px solid transparent',
            }}
          >
            <ShieldAlert size={16} color={activeTab === 'quarantine' ? 'var(--accent-amber)' : 'currentColor'} />
            Quarantined Events (Spec p24, p29)
            {quarantinedTotal > 0 && (
              <span
                style={{
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: '0.7rem',
                  background: 'rgba(245, 158, 11, 0.25)',
                  color: 'var(--accent-amber)',
                  fontWeight: 800,
                }}
              >
                {quarantinedTotal}
              </span>
            )}
          </button>
        </div>

        {/* Tab 1: Security Audit Log Table */}
        {activeTab === 'audit' && (
          <div className="glass-panel" style={{ overflow: 'hidden' }}>
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(255, 255, 255, 0.02)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ShieldCheck size={16} color="var(--accent-emerald)" />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>
                  Append-Only Verified Stream ({logs.length} events)
                </span>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                Tenant: {tenant?.tenantId}
              </span>
            </div>

            {loading ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                <div
                  className="animate-spin"
                  style={{
                    width: 32,
                    height: 32,
                    border: '2px solid rgba(99, 102, 241, 0.2)',
                    borderTopColor: 'var(--accent-indigo)',
                    borderRadius: '50%',
                    margin: '0 auto 12px',
                  }}
                />
                <div>Loading audit stream...</div>
              </div>
            ) : logs.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                No audit events recorded for this tenant yet.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '14px 20px', fontWeight: 600, fontSize: '0.775rem', textTransform: 'uppercase' }}>Timestamp</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600, fontSize: '0.775rem', textTransform: 'uppercase' }}>Action</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600, fontSize: '0.775rem', textTransform: 'uppercase' }}>Actor</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600, fontSize: '0.775rem', textTransform: 'uppercase' }}>IP / Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log, idx) => (
                      <tr
                        key={log._id || idx}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                          background: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.01)',
                        }}
                      >
                        <td style={{ padding: '14px 20px', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td style={{ padding: '14px 20px' }}>
                          {getActionBadge(log.action)}
                        </td>
                        <td style={{ padding: '14px 20px', color: '#fff', fontSize: '0.825rem', fontFamily: 'var(--font-mono)' }}>
                          {log.userId || <span style={{ color: 'var(--text-muted)' }}>System / Anonymous</span>}
                        </td>
                        <td style={{ padding: '14px 20px', color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                          {log.ip && <span>IP: {log.ip} · </span>}
                          {log.metadata ? JSON.stringify(log.metadata) : 'None'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Quarantined Domain Events Table (Spec p24, p29) */}
        {activeTab === 'quarantine' && (
          <div className="glass-panel" style={{ overflow: 'hidden' }}>
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(255, 255, 255, 0.02)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ShieldAlert size={16} color="var(--accent-amber)" />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>
                  Quarantined Domain Events Dead Letter Queue ({quarantinedEvents.length} items)
                </span>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Protected by Change Semantics (Spec p20)
              </span>
            </div>

            <div style={{ padding: '12px 20px', background: 'rgba(245, 158, 11, 0.05)', borderBottom: '1px solid rgba(245, 158, 11, 0.15)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Events with unknown schemas, stale entity versions, or producer mismatches are isolated here with a visible quarantine reason. They are permanently prevented from broadening campaign audiences or rolling state backwards.
            </div>

            {quarantinedLoading ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                <div
                  className="animate-spin"
                  style={{
                    width: 32,
                    height: 32,
                    border: '2px solid rgba(245, 158, 11, 0.2)',
                    borderTopColor: 'var(--accent-amber)',
                    borderRadius: '50%',
                    margin: '0 auto 12px',
                  }}
                />
                <div>Loading quarantined events...</div>
              </div>
            ) : quarantinedEvents.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                No quarantined events recorded. Domain event ingestion is fully synchronized.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '12px 18px', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>Event ID</th>
                      <th style={{ padding: '12px 18px', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>Producer / Type</th>
                      <th style={{ padding: '12px 18px', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>Entity ID &amp; Ver</th>
                      <th style={{ padding: '12px 18px', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>Quarantine Reason</th>
                      <th style={{ padding: '12px 18px', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>Occurred At</th>
                      <th style={{ padding: '12px 18px', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quarantinedEvents.map((evt) => (
                      <tr
                        key={evt._id || evt.eventId}
                        style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
                      >
                        <td style={{ padding: '12px 18px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#fff', fontSize: '0.8rem' }}>
                          {evt.eventId}
                        </td>
                        <td style={{ padding: '12px 18px' }}>
                          <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', fontSize: '0.75rem', marginRight: 6 }}>
                            {evt.producer}
                          </span>
                          <span style={{ color: '#c7d2fe', fontSize: '0.8rem' }}>{evt.eventType}</span>
                        </td>
                        <td style={{ padding: '12px 18px', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
                          {evt.entityId} (v{evt.entityVersion})
                        </td>
                        <td style={{ padding: '12px 18px' }}>
                          <span
                            style={{
                              padding: '3px 8px',
                              borderRadius: 4,
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              background: 'rgba(245, 158, 11, 0.15)',
                              color: 'var(--accent-amber)',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                            }}
                          >
                            {evt.quarantineReason || 'UNKNOWN'}
                          </span>
                        </td>
                        <td style={{ padding: '12px 18px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                          {evt.occurredAt ? new Date(evt.occurredAt).toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                          <button
                            type="button"
                            onClick={() => setSelectedQuarantineItem(evt)}
                            className="btn btn-secondary"
                            style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                          >
                            <Eye size={13} /> View Payload
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Modal for Raw Payload Inspection */}
        {selectedQuarantineItem && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              padding: 24,
            }}
          >
            <div
              className="glass-panel"
              style={{
                width: '100%',
                maxWidth: 640,
                maxHeight: '90vh',
                overflowY: 'auto',
                padding: 24,
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                    Quarantined Event Details
                  </h3>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    Event ID: <span className="font-mono">{selectedQuarantineItem.eventId}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedQuarantineItem(null)}
                  className="btn btn-secondary"
                  style={{ padding: '6px 10px', borderRadius: '50%' }}
                >
                  <X size={16} />
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 }}>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.02)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Quarantine Reason</div>
                  <div style={{ fontWeight: 700, color: 'var(--accent-amber)', fontSize: '0.85rem' }}>
                    {selectedQuarantineItem.quarantineReason}
                  </div>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.02)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Producer / Type</div>
                  <div style={{ fontWeight: 700, color: '#c7d2fe', fontSize: '0.85rem' }}>
                    {selectedQuarantineItem.producer} / {selectedQuarantineItem.eventType}
                  </div>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255, 255, 255, 0.02)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Entity ID &amp; Version</div>
                  <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>
                    {selectedQuarantineItem.entityId} (v{selectedQuarantineItem.entityVersion})
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                  Quarantined Raw Payload JSON:
                </div>
                <pre
                  className="font-mono"
                  style={{
                    background: 'rgba(0, 0, 0, 0.5)',
                    padding: 14,
                    borderRadius: 8,
                    fontSize: '0.8rem',
                    color: '#e2e8f0',
                    overflowX: 'auto',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {JSON.stringify(selectedQuarantineItem.payload, null, 2)}
                </pre>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setSelectedQuarantineItem(null)}
                  className="btn btn-secondary"
                  style={{ fontSize: '0.85rem', padding: '8px 18px' }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

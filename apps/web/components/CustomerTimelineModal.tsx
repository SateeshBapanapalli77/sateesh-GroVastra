'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  Clock,
  CheckCircle2,
  AlertTriangle,
  MessageCircle,
  Target,
  Layers,
  ChevronRight,
  Info,
  Calendar,
  ShieldCheck,
  Send,
  Eye,
  FileText,
  DollarSign,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { CustomerTimelineReport, CustomerTimelineStep } from '@grovastra/shared';

export interface CustomerTimelineModalProps {
  campaignId: string;
  customerId: string;
  onClose: () => void;
}

export function CustomerTimelineModal({
  campaignId,
  customerId,
  onClose,
}: CustomerTimelineModalProps) {
  const [timeline, setTimeline] = useState<CustomerTimelineReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadTimeline() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/campaigns/${campaignId}/customer-timeline/${customerId}`);
        if (res.ok) {
          const data: CustomerTimelineReport = await res.json();
          if (isMounted) setTimeline(data);
        } else {
          const err = await res.json();
          if (isMounted) setError(err?.error?.message || 'Failed to load customer timeline');
        }
      } catch {
        if (isMounted) setError('Network error fetching customer timeline');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadTimeline();
    return () => {
      isMounted = false;
    };
  }, [campaignId, customerId]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        zIndex: 1100,
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
          maxWidth: 820,
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: 28,
          background: '#0f172a',
          border: '1px solid rgba(99, 102, 241, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Modal Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                Customer Lifecycle Timeline
              </h3>
              <span
                style={{
                  fontSize: '0.7rem',
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: 'rgba(99, 102, 241, 0.15)',
                  color: 'var(--accent-cyan)',
                  fontWeight: 700,
                }}
              >
                Spec p28
              </span>
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              Customer: {customerId} &bull; Campaign: {campaignId}
            </span>
          </div>

          <button
            onClick={onClose}
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

        {loading && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
            <RefreshCw size={24} className="animate-spin" style={{ margin: '0 auto 10px' }} />
            <div>Loading customer timeline...</div>
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 16,
              borderRadius: 8,
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#fecdd3',
              fontSize: '0.85rem',
            }}
          >
            {error}
          </div>
        )}

        {timeline && (
          <>
            {/* Customer & Occurrence Header Banner */}
            <div
              style={{
                padding: '16px 20px',
                borderRadius: 10,
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 14,
                fontSize: '0.825rem',
              }}
            >
              <div>
                <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.7rem' }}>Customer</span>
                <strong style={{ color: '#fff', fontSize: '0.95rem' }}>{timeline.customerName}</strong>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                  {timeline.maskedPhone}
                </div>
              </div>

              <div>
                <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.7rem' }}>Occurrence</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <strong style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
                    {timeline.enrollment.occurrenceId}
                  </strong>
                  {(timeline.enrollment as any).occasionKind && (
                    <span
                      style={{
                        padding: '1px 6px',
                        borderRadius: 4,
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        background:
                          (timeline.enrollment as any).occasionKind === 'WEDDING'
                            ? 'rgba(168, 85, 247, 0.2)'
                            : 'rgba(245, 158, 11, 0.2)',
                        color:
                          (timeline.enrollment as any).occasionKind === 'WEDDING'
                            ? '#c084fc'
                            : '#fbbf24',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                      }}
                    >
                      {(timeline.enrollment as any).occasionKind}
                    </span>
                  )}
                  {((timeline.enrollment as any).planRevision || 1) > 1 && (
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
                      Replanned (Rev v{(timeline.enrollment as any).planRevision})
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: 2 }}>
                  Occasion Date: {timeline.enrollment.occasionLocalDate}
                </div>
              </div>

              <div>
                <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.7rem' }}>Enrollment Status</span>
                <span
                  style={{
                    display: 'inline-block',
                    marginTop: 4,
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: '0.7rem',
                    fontWeight: 800,
                    background:
                      timeline.enrollment.status === 'ACTIVE'
                        ? 'rgba(16, 185, 129, 0.2)'
                        : 'rgba(99, 102, 241, 0.2)',
                    color:
                      timeline.enrollment.status === 'ACTIVE'
                        ? '#34d399'
                        : '#a5b4fc',
                  }}
                >
                  {timeline.enrollment.status}
                </span>
              </div>
            </div>

            {/* Reschedule / Date Change History (Spec F22, Postponements) */}
            {(timeline.enrollment as any).dateHistory && (timeline.enrollment as any).dateHistory.length > 0 && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fbbf24', fontWeight: 700, fontSize: '0.8rem' }}>
                  <RefreshCw size={16} />
                  <span>Occasion Date Reschedule Trail (Atomic CAS Replanned)</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(timeline.enrollment as any).dateHistory.map((h: any, i: number) => (
                    <div
                      key={i}
                      style={{
                        fontSize: '0.75rem',
                        color: '#fef3c7',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <span style={{ color: 'var(--text-muted)' }}>Rev v{h.planRevision || i + 1}:</span>
                      <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{h.oldDate}</span>
                      <span>&rarr;</span>
                      <strong style={{ color: '#fff' }}>{h.newDate}</strong>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                        ({new Date(h.changedAt).toLocaleString()})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Why Selected Banner (Spec p28) */}
            <div
              style={{
                padding: '14px 18px',
                borderRadius: 8,
                background: 'rgba(99, 102, 241, 0.1)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <Info size={20} color="var(--accent-cyan)" style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: '0.75rem', color: '#c7d2fe', fontWeight: 700, textTransform: 'uppercase' }}>
                  Why this customer was selected (Explainability &bull; Spec p28)
                </div>
                <div style={{ fontSize: '0.875rem', color: '#fff', fontWeight: 600, marginTop: 2 }}>
                  {timeline.enrollment.matchExplanation}
                </div>
              </div>
            </div>

            {/* Chronological Step Execution Journey */}
            <div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 800, color: '#fff', marginBottom: 12 }}>
                Planned vs Actual Step Execution Journey ({timeline.steps.length} Steps)
              </h4>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {timeline.steps.map((st, idx) => {
                  const isAccepted = st.state === 'PROVIDER_ACCEPTED' || st.state === 'accepted';
                  const isSent = st.state === 'SENT';
                  const isDelivered = st.state === 'DELIVERED';
                  const isRead = st.state === 'READ';
                  const isSkipped = st.state === 'SKIPPED';
                  const isCancelled = st.state === 'CANCELLED';
                  const isDeferred = st.state === 'DEFERRED';

                  let badgeColor = '#34d399';
                  let badgeBg = 'rgba(16, 185, 129, 0.15)';
                  let badgeBorder = '1px solid rgba(16, 185, 129, 0.3)';

                  if (isRead) {
                    badgeColor = '#c4b5fd';
                    badgeBg = 'rgba(167, 139, 250, 0.2)';
                    badgeBorder = '1px solid rgba(167, 139, 250, 0.4)';
                  } else if (isDelivered) {
                    badgeColor = '#34d399';
                    badgeBg = 'rgba(52, 211, 153, 0.2)';
                    badgeBorder = '1px solid rgba(52, 211, 153, 0.4)';
                  } else if (isSent) {
                    badgeColor = '#38bdf8';
                    badgeBg = 'rgba(56, 189, 248, 0.2)';
                    badgeBorder = '1px solid rgba(56, 189, 248, 0.4)';
                  } else if (isAccepted) {
                    badgeColor = '#10b981';
                    badgeBg = 'rgba(16, 185, 129, 0.2)';
                    badgeBorder = '1px solid rgba(16, 185, 129, 0.4)';
                  } else if (isSkipped) {
                    badgeColor = '#fbbf24';
                    badgeBg = 'rgba(245, 158, 11, 0.15)';
                    badgeBorder = '1px solid rgba(245, 158, 11, 0.3)';
                  } else if (isCancelled) {
                    badgeColor = '#fb7185';
                    badgeBg = 'rgba(244, 63, 94, 0.15)';
                    badgeBorder = '1px solid rgba(244, 63, 94, 0.3)';
                  } else if (isDeferred) {
                    badgeColor = '#38bdf8';
                    badgeBg = 'rgba(14, 165, 233, 0.15)';
                    badgeBorder = '1px solid rgba(14, 165, 233, 0.3)';
                  }

                  return (
                    <div
                      key={st.executionId}
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
                      {/* Step Header */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            style={{
                              width: 24,
                              height: 24,
                              borderRadius: '50%',
                              background: 'rgba(255, 255, 255, 0.08)',
                              color: '#fff',
                              fontSize: '0.75rem',
                              fontWeight: 800,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {idx + 1}
                          </span>
                          <strong style={{ color: '#fff', fontSize: '0.95rem' }}>{st.stepName}</strong>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            ({st.stepId})
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {st.skipReason === 'INSUFFICIENT_LEAD_TIME' && (
                            <span
                              style={{
                                fontSize: '0.7rem',
                                fontWeight: 800,
                                padding: '3px 10px',
                                borderRadius: 6,
                                background: 'rgba(239, 68, 68, 0.2)',
                                color: '#fca5a5',
                                border: '1px solid rgba(239, 68, 68, 0.4)',
                              }}
                            >
                              Skipped: not enough time
                            </span>
                          )}
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontWeight: 800,
                              padding: '3px 10px',
                              borderRadius: 6,
                              background: badgeBg,
                              color: badgeColor,
                              border: badgeBorder,
                              fontFamily: 'var(--font-mono)',
                              letterSpacing: '0.04em',
                            }}
                          >
                            {st.state}
                          </span>
                        </div>
                      </div>

                      {st.skipReason === 'INSUFFICIENT_LEAD_TIME' && (
                        <div
                          style={{
                            padding: '8px 12px',
                            borderRadius: 6,
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.25)',
                            color: '#fecdd3',
                            fontSize: '0.75rem',
                          }}
                        >
                          {(st as any).usefulUntilReason || 'Skipped: Not enough fulfillment lead time before occasion event.'}
                        </div>
                      )}

                      {/* Planned vs Actual Comparison */}
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                          gap: 10,
                          padding: '12px',
                          background: 'rgba(0, 0, 0, 0.25)',
                          borderRadius: 8,
                          fontSize: '0.775rem',
                        }}
                      >
                        <div>
                          <span style={{ color: 'var(--text-muted)', display: 'block' }}>Planned Instant:</span>
                          <strong style={{ color: '#fff' }}>
                            {st.plannedLocalDate} at {st.plannedLocalTime} ({st.timezone})
                          </strong>
                          <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                            UTC: {new Date(st.plannedDueAt).toUTCString()}
                          </div>
                        </div>

                        <div>
                          <span style={{ color: 'var(--text-muted)', display: 'block' }}>Actual Outcomes:</span>
                          {st.actualDeliveredAt ? (
                            <span style={{ color: '#34d399' }}>
                              Delivered at {new Date(st.actualDeliveredAt).toLocaleTimeString()}
                            </span>
                          ) : st.actualDispatchedAt ? (
                            <span style={{ color: '#38bdf8' }}>
                              Dispatched at {new Date(st.actualDispatchedAt).toLocaleTimeString()}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>Not yet dispatched</span>
                          )}
                          {st.actualReadAt && (
                            <div style={{ color: '#c4b5fd', fontSize: '0.7rem' }}>
                              Read at {new Date(st.actualReadAt).toLocaleTimeString()} ✓✓
                            </div>
                          )}
                        </div>

                        <div>
                          <span style={{ color: 'var(--text-muted)', display: 'block' }}>Template Reference:</span>
                          {st.template ? (
                            <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                              {st.template.id} (rev {st.template.revision}, {st.template.language})
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>None assigned</span>
                          )}
                          {st.providerMessageId && (
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                              wamid: {st.providerMessageId.slice(0, 16)}...
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Stop Reason (if skipped, cancelled, or held) */}
                      {st.skipReason && (
                        <div
                          style={{
                            padding: '8px 12px',
                            borderRadius: 6,
                            background: 'rgba(245, 158, 11, 0.08)',
                            border: '1px solid rgba(245, 158, 11, 0.25)',
                            color: '#fde68a',
                            fontSize: '0.775rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <AlertTriangle size={14} color="var(--accent-amber)" />
                          <span>
                            <strong>Stop Reason:</strong> {st.skipReason}
                          </span>
                        </div>
                      )}

                      {/* Status Events History Log */}
                      {st.statusHistory && st.statusHistory.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>
                            Status Events Trail:
                          </span>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                            {st.statusHistory.map((ev, eIdx) => (
                              <div
                                key={`${ev.state}-${eIdx}`}
                                style={{
                                  fontSize: '0.725rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  color: 'var(--text-secondary)',
                                  fontFamily: 'var(--font-mono)',
                                }}
                              >
                                <span style={{ color: '#fff', fontWeight: 600 }}>[{ev.state}]</span>
                                <span>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                                {ev.details && <span style={{ color: 'var(--text-muted)' }}>&bull; {ev.details}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Linked Orders for this Customer */}
            <div
              style={{
                padding: '16px',
                borderRadius: 10,
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <strong style={{ color: '#fff', fontSize: '0.9rem' }}>
                  Attributed Store Orders ({timeline.linkedOrders.length})
                </strong>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  Delivery alone is never a sale
                </span>
              </div>

              {timeline.linkedOrders.length === 0 ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  No orders explicitly linked to this customer for this campaign. (Zero sales attributed).
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {timeline.linkedOrders.map((ord) => (
                    <div
                      key={ord.orderId}
                      style={{
                        padding: '10px 14px',
                        borderRadius: 6,
                        background: 'rgba(16, 185, 129, 0.08)',
                        border: '1px solid rgba(16, 185, 129, 0.25)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '0.8rem',
                      }}
                    >
                      <div>
                        <strong style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>{ord.orderId}</strong>
                        <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                          Occasion: {ord.occasionRef || 'None'} &bull; Source: {ord.attributionSource}
                        </span>
                      </div>
                      <div style={{ color: '#34d399', fontWeight: 800 }}>
                        ₹{ord.netRupees.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

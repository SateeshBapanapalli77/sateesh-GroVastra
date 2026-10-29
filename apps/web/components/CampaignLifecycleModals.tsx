'use client';

import React, { useState, useEffect } from 'react';
import {
  Pause,
  Play,
  Archive,
  AlertTriangle,
  AlertOctagon,
  Clock,
  Send,
  Users,
  CheckCircle2,
  Loader2,
  X,
  ShieldAlert,
} from 'lucide-react';

interface PausePreviewData {
  campaignId: string;
  currentStatus: string;
  affectedCounts: {
    scheduledCount: number;
    inProgressCount: number;
    activeEnrollmentsCount: number;
  };
  honestMessage: string;
  notice: string;
}

interface ResumePreviewData {
  campaignId: string;
  currentStatus: string;
  policy: string;
  affectedCounts: {
    futureCount: number;
    overdueCount: number;
    inProgressCount: number;
    activeEnrollmentsCount: number;
  };
  honestMessage: string;
  notice: string;
}

interface ArchivePreviewData {
  campaignId: string;
  currentStatus: string;
  affectedCounts: {
    unsubmittedCancelledCount: number;
    inProgressCount: number;
    acceptedOrDeliveredCount: number;
    unknownCount: number;
    failedOrSkippedCount: number;
    activeEnrollmentsCount: number;
  };
  honestMessage: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

export function PauseModal({
  isOpen,
  campaignId,
  campaignName,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  campaignId: string;
  campaignName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PausePreviewData | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);

    const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_token') : null;
    fetch(`${API_BASE}/campaigns/${campaignId}/pause/preview`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || 'Failed to fetch pause preview');
        }
        return res.json();
      })
      .then((data) => setPreview(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [isOpen, campaignId]);

  if (!isOpen) return null;

  const handleConfirmPause = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_token') : null;
      const res = await fetch(`${API_BASE}/campaigns/${campaignId}/pause`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `pause_${campaignId}_${Date.now()}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to pause campaign');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        padding: 20,
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--bg-secondary)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* Header */}
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
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'rgba(245, 158, 11, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-amber)',
              }}
            >
              <Pause size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                Pause Campaign
              </h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {campaignName}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px' }}>
          {error && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
                fontSize: '0.85rem',
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div style={{ padding: '36px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
              <Loader2 className="animate-spin" size={28} style={{ margin: '0 auto 10px', color: 'var(--accent-amber)' }} />
              <div>Analyzing campaign schedules and in-flight submissions...</div>
            </div>
          ) : preview ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Counts Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    textAlign: 'center',
                  }}
                >
                  <Clock size={16} color="var(--accent-amber)" style={{ margin: '0 auto 6px' }} />
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff' }}>
                    {preview.affectedCounts.scheduledCount}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    Scheduled (Held)
                  </div>
                </div>

                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    textAlign: 'center',
                  }}
                >
                  <Send size={16} color="var(--accent-cyan)" style={{ margin: '0 auto 6px' }} />
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff' }}>
                    {preview.affectedCounts.inProgressCount}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    In-Flight Sends
                  </div>
                </div>

                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    textAlign: 'center',
                  }}
                >
                  <Users size={16} color="var(--accent-indigo)" style={{ margin: '0 auto 6px' }} />
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff' }}>
                    {preview.affectedCounts.activeEnrollmentsCount}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    Enrolled Occasions
                  </div>
                </div>
              </div>

              {/* Honest Boundary Notice (Spec p29, B12) */}
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <AlertTriangle size={18} color="var(--accent-amber)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '0.825rem', lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700, color: '#fff', marginBottom: 2 }}>
                    Honest Engine Boundary (Spec p20, p29, B12)
                  </div>
                  <div style={{ color: '#fef3c7' }}>
                    <strong>{preview.honestMessage}</strong>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: 4 }}>
                    Unsubmitted steps stop immediately. In-flight dispatches already submitted to Meta cannot be recalled. Future schedules remain safely frozen.
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <button
            onClick={onClose}
            className="btn btn-secondary"
            disabled={submitting}
            style={{ fontSize: '0.85rem' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmPause}
            disabled={submitting || loading}
            className="btn btn-primary"
            style={{
              fontSize: '0.85rem',
              background: 'linear-gradient(135deg, #d97706, #b45309)',
              borderColor: '#f59e0b',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" size={15} />
                Pausing Engine...
              </>
            ) : (
              <>
                <Pause size={15} />
                Pause Campaign
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResumeModal({
  isOpen,
  campaignId,
  campaignName,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  campaignId: string;
  campaignName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResumePreviewData | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);

    const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_token') : null;
    fetch(`${API_BASE}/campaigns/${campaignId}/resume/preview`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || 'Failed to fetch resume preview');
        }
        return res.json();
      })
      .then((data) => setPreview(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [isOpen, campaignId]);

  if (!isOpen) return null;

  const handleConfirmResume = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_token') : null;
      const res = await fetch(`${API_BASE}/campaigns/${campaignId}/resume`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `resume_${campaignId}_${Date.now()}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ policy: 'FUTURE_ONLY' }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to resume campaign');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        padding: 20,
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--bg-secondary)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* Header */}
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
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'rgba(16, 185, 129, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-emerald)',
              }}
            >
              <Play size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                  Resume Campaign
                </h3>
                <span
                  style={{
                    fontSize: '0.675rem',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: 'rgba(16, 185, 129, 0.2)',
                    color: '#a7f3d0',
                    fontWeight: 700,
                  }}
                >
                  FUTURE_ONLY
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {campaignName}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px' }}>
          {error && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
                fontSize: '0.85rem',
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div style={{ padding: '36px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
              <Loader2 className="animate-spin" size={28} style={{ margin: '0 auto 10px', color: 'var(--accent-emerald)' }} />
              <div>Calculating future schedules and missed steps...</div>
            </div>
          ) : preview ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Counts Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: 'rgba(16, 185, 129, 0.08)',
                    border: '1px solid rgba(16, 185, 129, 0.25)',
                    textAlign: 'center',
                  }}
                >
                  <Clock size={18} color="var(--accent-emerald)" style={{ margin: '0 auto 6px' }} />
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff' }}>
                    {preview.affectedCounts.futureCount}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#a7f3d0' }}>
                    Valid Future Steps Resuming
                  </div>
                </div>

                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    textAlign: 'center',
                  }}
                >
                  <AlertTriangle size={18} color="var(--accent-amber)" style={{ margin: '0 auto 6px' }} />
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff' }}>
                    {preview.affectedCounts.overdueCount}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Overdue Steps (Skipped - No Burst)
                  </div>
                </div>
              </div>

              {/* Zero Burst Policy Guarantee Banner (Spec p20, B13) */}
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <CheckCircle2 size={18} color="var(--accent-emerald)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '0.825rem', lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700, color: '#fff', marginBottom: 2 }}>
                    Zero Message Burst Guarantee (Spec p20, B13)
                  </div>
                  <div style={{ color: '#d1fae5' }}>
                    {preview.notice}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: 4 }}>
                    Steps that passed during the pause will be marked SKIPPED with reasons logged in MongoDB. Calendar evaluation triggers immediately for upcoming occasions.
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <button
            onClick={onClose}
            className="btn btn-secondary"
            disabled={submitting}
            style={{ fontSize: '0.85rem' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmResume}
            disabled={submitting || loading}
            className="btn btn-primary"
            style={{
              fontSize: '0.85rem',
              background: 'linear-gradient(135deg, #059669, #047857)',
              borderColor: '#10b981',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" size={15} />
                Resuming Engine...
              </>
            ) : (
              <>
                <Play size={15} />
                Resume Campaign
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ArchiveModal({
  isOpen,
  campaignId,
  campaignName,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  campaignId: string;
  campaignName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArchivePreviewData | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);

    const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_token') : null;
    fetch(`${API_BASE}/campaigns/${campaignId}/archive/preview`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || 'Failed to fetch archive preview');
        }
        return res.json();
      })
      .then((data) => setPreview(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [isOpen, campaignId]);

  if (!isOpen) return null;

  const handleConfirmArchive = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('grovastra_token') : null;
      const res = await fetch(`${API_BASE}/campaigns/${campaignId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `archive_${campaignId}_${Date.now()}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to archive campaign');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        padding: 20,
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--bg-secondary)',
          border: '1px solid rgba(244, 63, 94, 0.3)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* Header */}
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
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'rgba(244, 63, 94, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-rose)',
              }}
            >
              <Archive size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                Archive Campaign
              </h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {campaignName}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px' }}>
          {error && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
                fontSize: '0.85rem',
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div style={{ padding: '36px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
              <Loader2 className="animate-spin" size={28} style={{ margin: '0 auto 10px', color: 'var(--accent-rose)' }} />
              <div>Auditing unsubmitted steps and preserved historical outcomes...</div>
            </div>
          ) : preview ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Counts Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: 'rgba(244, 63, 94, 0.08)',
                    border: '1px solid rgba(244, 63, 94, 0.25)',
                    textAlign: 'center',
                  }}
                >
                  <AlertOctagon size={18} color="var(--accent-rose)" style={{ margin: '0 auto 6px' }} />
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff' }}>
                    {preview.affectedCounts.unsubmittedCancelledCount}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#fca5a5' }}>
                    Unsubmitted Work Cancelled
                  </div>
                </div>

                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    textAlign: 'center',
                  }}
                >
                  <ShieldAlert size={18} color="var(--accent-indigo)" style={{ margin: '0 auto 6px' }} />
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff' }}>
                    {preview.affectedCounts.acceptedOrDeliveredCount + preview.affectedCounts.unknownCount}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Historical Records Preserved
                  </div>
                </div>
              </div>

              {/* Honest Boundary Notice (Spec p9, p20) */}
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: 'rgba(244, 63, 94, 0.08)',
                  border: '1px solid rgba(244, 63, 94, 0.25)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <AlertOctagon size={18} color="var(--accent-rose)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '0.825rem', lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700, color: '#fff', marginBottom: 2 }}>
                    Permanent Archive Boundary (Spec p9, p20)
                  </div>
                  <div style={{ color: '#fecdd3' }}>
                    <strong>{preview.honestMessage}</strong>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: 4 }}>
                    Archive stops new customer enrollments, cancels unsent work, and freezes campaign status permanently. All historical deliveries and provider outcomes remain preserved.
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <button
            onClick={onClose}
            className="btn btn-secondary"
            disabled={submitting}
            style={{ fontSize: '0.85rem' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmArchive}
            disabled={submitting || loading}
            className="btn btn-primary"
            style={{
              fontSize: '0.85rem',
              background: 'linear-gradient(135deg, #e11d48, #be123c)',
              borderColor: '#f43f5e',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" size={15} />
                Archiving Campaign...
              </>
            ) : (
              <>
                <Archive size={15} />
                Archive Campaign
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

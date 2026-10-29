'use client';

import React from 'react';
import {
  Lock,
  Clock,
  Sparkles,
  Play,
  AlertTriangle,
  Loader2,
  X,
  ShieldCheck,
  Calendar,
  Layers,
} from 'lucide-react';
import { Campaign, CampaignVersion, CampaignDryRun } from '@grovastra/shared';

export interface ActivationModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  activating: boolean;
  campaign: Campaign;
  draft: CampaignVersion;
  dryRun: CampaignDryRun | null;
  isRevision: boolean;
  error?: string | null;
}

export function ActivationModal({
  open,
  onClose,
  onConfirm,
  activating,
  campaign,
  draft,
  dryRun,
  isRevision,
  error,
}: ActivationModalProps) {
  if (!open) return null;

  const fingerprint = dryRun?.draftFingerprint || 'sha256-verified';
  const eligibleCount = dryRun?.counts?.eligible ?? 0;
  const isZeroEligible = eligibleCount === 0;

  return (
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
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 580,
          padding: 28,
          background: 'var(--bg-secondary)',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6), 0 0 30px rgba(99, 102, 241, 0.15)',
          position: 'relative',
        }}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          disabled={activating}
          style={{
            position: 'absolute',
            top: 20,
            right: 20,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          <X size={20} />
        </button>

        {/* Modal Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 10,
              background: isRevision
                ? 'rgba(6, 182, 212, 0.15)'
                : 'rgba(16, 185, 129, 0.15)',
              border: isRevision
                ? '1px solid rgba(6, 182, 212, 0.3)'
                : '1px solid rgba(16, 185, 129, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isRevision ? (
              <Sparkles size={22} color="var(--accent-cyan)" />
            ) : (
              <Play size={22} color="var(--accent-emerald)" />
            )}
          </div>
          <div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', margin: 0 }}>
              {isRevision ? 'Publish Campaign Revision' : 'Confirm Campaign Activation'}
            </h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {draft.name} &bull; Draft Version v{draft.version}
            </span>
          </div>
        </div>

        {/* Notice of What Happens */}
        <div style={{ margin: '20px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              padding: 14,
              borderRadius: 8,
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              fontSize: '0.85rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Lock size={16} color="var(--accent-cyan)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong style={{ color: '#fff' }}>Immutable Version v{draft.version}:</strong>
                <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>
                  Freezes an immutable campaign version snapshot. Trigger, steps, templates, and
                  audience rules cannot be altered once activated (Hard Rule 6).
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Clock size={16} color="var(--accent-indigo)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong style={{ color: '#fff' }}>Autonomous Next Evaluation:</strong>
                <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>
                  Schedules the next evaluation according to tenant sending hours. No messages are sent
                  immediately upon activation.
                </span>
              </div>
            </div>

            {isRevision && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <Layers size={16} color="var(--accent-amber)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <strong style={{ color: '#fff' }}>Enrollment Version Pinning:</strong>
                  <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>
                    Existing enrollments remain pinned to their original version. Only new candidate
                    enrollments will execute version v{draft.version} (Spec p9, B14).
                  </span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <ShieldCheck size={16} color="var(--accent-emerald)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong style={{ color: '#fff' }}>Review Fingerprint:</strong>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginLeft: 6 }}>
                  {fingerprint.substring(0, 24)}...
                </span>
              </div>
            </div>
          </div>

          {/* Warnings Section */}
          {isZeroEligible && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: '0.8rem',
                color: '#fde68a',
              }}
            >
              <AlertTriangle size={18} color="var(--accent-amber)" style={{ flexShrink: 0 }} />
              <span>
                <strong>A04 Zero Matches:</strong> No eligible customers match today. The campaign
                will activate normally; future customer birthdays or occasions will qualify automatically.
              </span>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '10px 14px',
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
        </div>

        {/* Modal Action Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={activating}
            className="btn btn-secondary"
            style={{ padding: '8px 18px' }}
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={onConfirm}
            disabled={activating}
            className="btn btn-primary"
            style={{
              padding: '8px 22px',
              background: isRevision ? 'var(--accent-cyan)' : 'var(--accent-emerald)',
              borderColor: isRevision ? 'var(--accent-cyan)' : 'var(--accent-emerald)',
              color: '#000',
              fontWeight: 700,
            }}
          >
            {activating ? (
              <>
                <Loader2 className="animate-spin" size={16} />
                {isRevision ? 'Publishing Revision...' : 'Activating Campaign...'}
              </>
            ) : isRevision ? (
              <>
                <Sparkles size={16} />
                Confirm &amp; Publish Revision v{draft.version}
              </>
            ) : (
              <>
                <Play size={16} />
                Confirm &amp; Activate Campaign
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

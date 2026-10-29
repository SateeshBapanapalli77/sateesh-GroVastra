'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Clock,
  CalendarOff,
  Sliders,
  ShieldAlert,
  Save,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  Plus,
  Trash2,
  Info,
  Sparkles,
  Lock,
  Pause,
  Play,
  AlertOctagon,
} from 'lucide-react';
import {
  CampaignSettings,
  CAMPAIGN_SETTINGS_LIMITS,
  isValidISODate,
  isValidIANATimezone,
  isValidBookingLinkUrl,
  UserRole,
} from '@grovastra/shared';

const TIMEZONE_PRESETS = [
  { label: 'Asia/Kolkata (IST)', value: 'Asia/Kolkata' },
  { label: 'Asia/Dubai (GST)', value: 'Asia/Dubai' },
  { label: 'UTC', value: 'UTC' },
  { label: 'America/New_York (EST)', value: 'America/New_York' },
  { label: 'Europe/London (GMT/BST)', value: 'Europe/London' },
  { label: 'Asia/Singapore (SGT)', value: 'Asia/Singapore' },
];

interface ConflictDetails {
  expectedVersion: number;
  currentVersion: number;
  message: string;
}

interface CampaignSettingsManagerProps {
  userRole?: UserRole;
  tenantName?: string;
}

export function CampaignSettingsManager({ userRole = 'owner', tenantName }: CampaignSettingsManagerProps) {
  const isReadOnly = userRole === 'staff';

  const [settings, setSettings] = useState<CampaignSettings | null>(null);
  const [formData, setFormData] = useState<CampaignSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictDetails | null>(null);

  // Sub-forms for adding blackouts and holidays
  const [newBlackoutDate, setNewBlackoutDate] = useState('');
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');

  // Fetch settings from server
  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMessage(null);
      setConflict(null);

      const res = await fetch('/api/campaign-settings', {
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error?.message || `Failed to fetch campaign settings (${res.status})`);
      }

      const data: CampaignSettings = await res.json();
      setSettings(data);
      setFormData(JSON.parse(JSON.stringify(data)));
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error fetching campaign settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Compute validation errors in real time
  const validationErrors = useMemo(() => {
    if (!formData) return {};
    const errors: Record<string, string> = {};

    // 1. Timezone
    if (!formData.timezone || !isValidIANATimezone(formData.timezone)) {
      errors.timezone = 'Must be a valid IANA timezone identifier (e.g. Asia/Kolkata)';
    }

    // 2. Allowed sending hours
    const { start, end } = formData.allowedSendingHours;
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(start)) {
      errors['sendingHours.start'] = 'Start time must be in HH:mm 24h format';
    }
    if (!timeRegex.test(end)) {
      errors['sendingHours.end'] = 'End time must be in HH:mm 24h format';
    }

    if (timeRegex.test(start) && timeRegex.test(end)) {
      const [sH, sM] = start.split(':').map(Number);
      const [eH, eM] = end.split(':').map(Number);
      const sMin = sH * 60 + sM;
      const eMin = eH * 60 + eM;

      if (sMin === eMin) {
        errors['sendingHours.window'] = 'Start and end time cannot be equal (spec p7 requires a non-zero sending window)';
      } else if (sMin > eMin) {
        errors['sendingHours.window'] = 'Overnight sending hours (start after end) are not supported in v1 (spec p7)';
      }
    }

    // 3. Marketing Caps (Owner may only TIGHTEN inherited caps)
    if (formData.marketingCaps.daily > CAMPAIGN_SETTINGS_LIMITS.MAX_DAILY_MARKETING_CAP) {
      errors['caps.daily'] = `Daily cap cannot exceed tenant ceiling of ${CAMPAIGN_SETTINGS_LIMITS.MAX_DAILY_MARKETING_CAP} per 24 hours (spec p7, p18)`;
    }
    if (formData.marketingCaps.daily < 0) {
      errors['caps.daily'] = 'Daily cap cannot be negative';
    }
    if (formData.marketingCaps.weekly > CAMPAIGN_SETTINGS_LIMITS.MAX_WEEKLY_MARKETING_CAP) {
      errors['caps.weekly'] = `Weekly cap cannot exceed tenant ceiling of ${CAMPAIGN_SETTINGS_LIMITS.MAX_WEEKLY_MARKETING_CAP} per 7 days (spec p7, p18)`;
    }
    if (formData.marketingCaps.weekly < 0) {
      errors['caps.weekly'] = 'Weekly cap cannot be negative';
    }
    if (
      formData.marketingCaps.daily > 0 &&
      formData.marketingCaps.weekly < formData.marketingCaps.daily
    ) {
      errors['caps.weekly'] = 'Weekly marketing cap cannot be less than daily marketing cap';
    }

    // 4. Service contact spacing
    if (
      formData.serviceContactSpacingHours < CAMPAIGN_SETTINGS_LIMITS.MIN_SERVICE_CONTACT_SPACING_HOURS ||
      formData.serviceContactSpacingHours > CAMPAIGN_SETTINGS_LIMITS.MAX_SERVICE_CONTACT_SPACING_HOURS
    ) {
      errors.serviceSpacing = `Spacing must be between 1 and ${CAMPAIGN_SETTINGS_LIMITS.MAX_SERVICE_CONTACT_SPACING_HOURS} hours`;
    }

    // 5. Outage grace
    if (
      formData.outageGraceHours < CAMPAIGN_SETTINGS_LIMITS.MIN_OUTAGE_GRACE_HOURS ||
      formData.outageGraceHours > CAMPAIGN_SETTINGS_LIMITS.MAX_OUTAGE_GRACE_HOURS
    ) {
      errors.outageGrace = `Outage grace must be between 1 and ${CAMPAIGN_SETTINGS_LIMITS.MAX_OUTAGE_GRACE_HOURS} hours`;
    }

    // 6. Booking link validation (Spec F22, Wedding Campaigns)
    if (formData.bookingLinkUrl && formData.bookingLinkUrl.trim() !== '') {
      if (!isValidBookingLinkUrl(formData.bookingLinkUrl.trim())) {
        errors['bookingLinkUrl'] =
          'Booking link must be a valid https URL with a public domain (no IP literals, no localhost, no credentials, max 200 chars)';
      }
    }

    // 6. Priorities
    Object.entries(formData.priorityAllowlistRanges).forEach(([key, val]) => {
      if (val < CAMPAIGN_SETTINGS_LIMITS.MIN_PRIORITY || val > CAMPAIGN_SETTINGS_LIMITS.MAX_PRIORITY) {
        errors[`priority.${key}`] = `Priority must be between 1 and 100`;
      }
    });

    return errors;
  }, [formData]);

  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  // Determine if form has unsaved edits
  const isDirty = useMemo(() => {
    if (!settings || !formData) return false;
    return JSON.stringify(settings) !== JSON.stringify(formData);
  }, [settings, formData]);

  // Handle Save
  const handleSave = async () => {
    if (!formData || isReadOnly || hasValidationErrors) return;

    setSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    setConflict(null);

    const idempotencyKey = `ui_save_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      const payload = {
        expectedVersion: formData.version,
        timezone: formData.timezone,
        allowedSendingHours: formData.allowedSendingHours,
        blackoutDates: formData.blackoutDates,
        holidays: formData.holidays,
        marketingCaps: formData.marketingCaps,
        serviceContactSpacingHours: Number(formData.serviceContactSpacingHours),
        outageGraceHours: Number(formData.outageGraceHours),
        resumePolicy: 'FUTURE_ONLY',
        importPolicy: 'FUTURE_ONLY',
        priorityAllowlistRanges: formData.priorityAllowlistRanges,
        bookingLinkUrl: formData.bookingLinkUrl ? formData.bookingLinkUrl.trim() : null,
        isPaused: formData.isPaused,
      };

      const res = await fetch('/api/campaign-settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.status === 409) {
        // Optimistic concurrency version conflict!
        const details = data.error?.details || {};
        setConflict({
          expectedVersion: details.expectedVersion ?? formData.version,
          currentVersion: details.currentVersion ?? (formData.version + 1),
          message:
            data.error?.message ||
            `Version conflict: The settings were updated in another tab or session (Current server revision: v${details.currentVersion}).`,
        });
        return;
      }

      if (!res.ok) {
        const detailsText = Array.isArray(data.error?.details)
          ? data.error.details.map((d: any) => `${d.field}: ${d.message}`).join(', ')
          : '';
        throw new Error(
          (data.error?.message || 'Failed to save campaign settings') +
            (detailsText ? ` (${detailsText})` : '')
        );
      }

      // Success
      setSettings(data);
      setFormData(JSON.parse(JSON.stringify(data)));
      setSuccessMessage(
        `Campaign settings successfully saved! (Revision v${data.version} recorded in immutable audit log)`
      );
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Immediate Tenant Global Pause Toggle (F13, Spec p20, p25)
  const handleToggleGlobalPause = async (newPaused: boolean) => {
    if (!formData) return;
    try {
      setSaving(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      const res = await fetch('/api/campaign-settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `global_pause_${Date.now()}`,
        },
        body: JSON.stringify({
          expectedVersion: formData.version,
          isPaused: newPaused,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to update global emergency dispatch status');
      }

      setSettings(data);
      setFormData(JSON.parse(JSON.stringify(data)));
      setSuccessMessage(
        newPaused
          ? 'Emergency Global Pause activated: All campaign submissions across tenant are frozen immediately.'
          : 'Global dispatch resumed: Campaigns are active and accepting submissions.'
      );
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to update global pause');
    } finally {
      setSaving(false);
    }
  };

  // Blackout date helpers
  const handleAddBlackoutDate = () => {
    if (!newBlackoutDate || !isValidISODate(newBlackoutDate) || !formData) return;
    if (formData.blackoutDates.includes(newBlackoutDate)) return;

    setFormData({
      ...formData,
      blackoutDates: [...formData.blackoutDates, newBlackoutDate].sort(),
    });
    setNewBlackoutDate('');
  };

  const handleRemoveBlackoutDate = (dateToRemove: string) => {
    if (!formData || isReadOnly) return;
    setFormData({
      ...formData,
      blackoutDates: formData.blackoutDates.filter((d) => d !== dateToRemove),
    });
  };

  // Holiday helpers
  const handleAddHoliday = () => {
    if (!newHolidayDate || !isValidISODate(newHolidayDate) || !newHolidayName.trim() || !formData) return;
    if (formData.holidays.some((h) => h.date === newHolidayDate)) return;

    setFormData({
      ...formData,
      holidays: [...formData.holidays, { date: newHolidayDate, name: newHolidayName.trim() }].sort((a, b) =>
        a.date.localeCompare(b.date)
      ),
    });
    setNewHolidayDate('');
    setNewHolidayName('');
  };

  const handleRemoveHoliday = (dateToRemove: string) => {
    if (!formData || isReadOnly) return;
    setFormData({
      ...formData,
      holidays: formData.holidays.filter((h) => h.date !== dateToRemove),
    });
  };

  if (loading) {
    return (
      <div className="glass-panel" style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
        Loading boutique campaign policies...
      </div>
    );
  }

  if (!formData) {
    return (
      <div className="glass-panel" style={{ padding: 24 }}>
        <p style={{ color: 'var(--accent-rose)' }}>Unable to load campaign settings.</p>
        <button onClick={loadSettings} className="btn btn-secondary" style={{ marginTop: 12 }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Role permission info banner for Staff */}
      {isReadOnly && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(99, 102, 241, 0.1)',
            border: '1px solid rgba(99, 102, 241, 0.3)',
            color: '#c7d2fe',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Lock size={18} color="var(--accent-indigo)" />
          <span>
            <strong>View-Only Permission:</strong> Staff role has read-only access to campaign settings and policies.
            Owner or Admin role required to modify configuration.
          </span>
        </div>
      )}

      {/* Version Conflict Alert (HTTP 409) */}
      {conflict && (
        <div
          style={{
            padding: '18px 20px',
            borderRadius: 12,
            background: 'rgba(244, 63, 94, 0.15)',
            border: '2px solid rgba(244, 63, 94, 0.6)',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            animation: 'pulse-glow-red 2s infinite ease-in-out',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <AlertTriangle size={24} color="var(--accent-rose)" />
            <div>
              <div style={{ fontWeight: 800, fontSize: '1rem', color: '#fecdd3' }}>
                Version Conflict Detected (HTTP 409 Conflict)
              </div>
              <div style={{ fontSize: '0.875rem', color: '#ffe4e6', marginTop: 2 }}>
                {conflict.message}
              </div>
            </div>
          </div>
          <div style={{ fontSize: '0.825rem', color: '#fecdd3', lineHeight: 1.5 }}>
            Another tab or administrator saved changes while you were editing (Your form version:{' '}
            <strong>v{conflict.expectedVersion}</strong>, Database current version:{' '}
            <strong>v{conflict.currentVersion}</strong>). To prevent accidental overwrites, please reload the latest
            settings before making new edits.
          </div>
          <div>
            <button
              onClick={loadSettings}
              className="btn btn-gold"
              style={{ padding: '8px 16px', fontSize: '0.85rem' }}
            >
              <RotateCcw size={14} />
              <span>Reload Latest Settings (v{conflict.currentVersion})</span>
            </button>
          </div>
        </div>
      )}

      {/* General Error Banner */}
      {errorMessage && !conflict && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(244, 63, 94, 0.12)',
            border: '1px solid rgba(244, 63, 94, 0.3)',
            color: '#fecdd3',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <AlertTriangle size={18} />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Success Banner */}
      {successMessage && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            color: '#a7f3d0',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <CheckCircle2 size={18} />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Top Action Bar */}
      <div
        className="glass-panel"
        style={{
          padding: '16px 20px',
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
              padding: '6px 12px',
              borderRadius: 8,
              background: 'rgba(99, 102, 241, 0.15)',
              border: '1px solid rgba(99, 102, 241, 0.3)',
              color: '#818cf8',
              fontSize: '0.8rem',
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
            }}
          >
            Revision: v{formData.version}
          </div>
          {isDirty && (
            <span style={{ fontSize: '0.8rem', color: 'var(--accent-amber)', fontWeight: 600 }}>
              ● Unsaved changes
            </span>
          )}
          {!isDirty && (
            <span style={{ fontSize: '0.8rem', color: 'var(--accent-emerald)', fontWeight: 600 }}>
              ✓ Synced with server
            </span>
          )}
        </div>

        {!isReadOnly && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {isDirty && (
              <button
                onClick={() => setFormData(JSON.parse(JSON.stringify(settings)))}
                disabled={saving}
                className="btn btn-secondary"
                style={{ padding: '8px 14px', fontSize: '0.825rem' }}
              >
                <RotateCcw size={14} />
                <span>Discard Changes</span>
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !isDirty || hasValidationErrors}
              className="btn btn-primary"
              style={{ padding: '8px 18px', fontSize: '0.85rem' }}
            >
              <Save size={16} />
              <span>{saving ? 'Saving...' : 'Save Settings'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Grid of 4 Sections */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 20 }}>
        {/* ================================================================= */}
        {/* SECTION 1: TIME AND SENDING HOURS                                */}
        {/* ================================================================= */}
        <div className="glass-panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Clock size={20} color="var(--accent-indigo)" />
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>Time & Sending Hours</h3>
              <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)' }}>
                Spec p7: IANA timezone, permitted dispatch window (start inclusive, end exclusive).
              </p>
            </div>
          </div>

          {/* Timezone */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Boutique Timezone (IANA)
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              {TIMEZONE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  disabled={isReadOnly}
                  onClick={() => setFormData({ ...formData, timezone: p.value })}
                  className="quick-chip"
                  style={{
                    borderColor: formData.timezone === p.value ? 'var(--accent-indigo)' : undefined,
                    background: formData.timezone === p.value ? 'rgba(99, 102, 241, 0.2)' : undefined,
                    color: formData.timezone === p.value ? '#fff' : undefined,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="text"
              className="form-input"
              disabled={isReadOnly}
              value={formData.timezone}
              onChange={(e) => setFormData({ ...formData, timezone: e.target.value.trim() })}
              placeholder="e.g. Asia/Kolkata"
            />
            {validationErrors.timezone && (
              <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                {validationErrors.timezone}
              </p>
            )}
          </div>

          {/* Allowed Sending Hours */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Allowed Sending Hours (Daily Window)
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  Start Time (Inclusive)
                </span>
                <input
                  type="time"
                  className="form-input"
                  disabled={isReadOnly}
                  value={formData.allowedSendingHours.start}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      allowedSendingHours: { ...formData.allowedSendingHours, start: e.target.value },
                    })
                  }
                />
                {validationErrors['sendingHours.start'] && (
                  <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                    {validationErrors['sendingHours.start']}
                  </p>
                )}
              </div>

              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  End Time (Exclusive)
                </span>
                <input
                  type="time"
                  className="form-input"
                  disabled={isReadOnly}
                  value={formData.allowedSendingHours.end}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      allowedSendingHours: { ...formData.allowedSendingHours, end: e.target.value },
                    })
                  }
                />
                {validationErrors['sendingHours.end'] && (
                  <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                    {validationErrors['sendingHours.end']}
                  </p>
                )}
              </div>
            </div>

            {validationErrors['sendingHours.window'] && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(244, 63, 94, 0.1)',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                  color: '#fecdd3',
                  fontSize: '0.775rem',
                }}
              >
                ⚠️ {validationErrors['sendingHours.window']}
              </div>
            )}

            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
              💡 Messages are only dispatched within permitted daytime hours. Equal hours and overnight sending
              (crossing midnight) are rejected per spec p7.
            </p>

            {/* Booking Link URL (Spec F22, Wedding Campaigns) */}
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border-color)' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                Store Booking Link URL (Wedding Campaigns)
              </label>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                Public HTTPS booking link for bridal appointments. Required when activating wedding reminder campaigns with booking links.
              </p>
              <input
                id="input-booking-link-url"
                type="url"
                className="form-input"
                disabled={isReadOnly}
                placeholder="https://example.com/book"
                value={formData.bookingLinkUrl || ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    bookingLinkUrl: e.target.value,
                  })
                }
              />
              {validationErrors['bookingLinkUrl'] && (
                <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                  {validationErrors['bookingLinkUrl']}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ================================================================= */}
        {/* SECTION 2: BLACKOUT DATES AND HOLIDAYS                           */}
        {/* ================================================================= */}
        <div className="glass-panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CalendarOff size={20} color="var(--accent-amber)" />
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>Blackouts & Holidays</h3>
              <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)' }}>
                Spec p7: Days when promotional sends are suppressed.
              </p>
            </div>
          </div>

          {/* Blackout Dates List */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Blackout Dates ({formData.blackoutDates.length})
            </label>

            {formData.blackoutDates.length === 0 ? (
              <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)', marginBottom: 10 }}>
                No blackout dates configured.
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {formData.blackoutDates.map((dateStr) => (
                  <span
                    key={dateStr}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 8,
                      background: 'rgba(244, 63, 94, 0.15)',
                      border: '1px solid rgba(244, 63, 94, 0.35)',
                      color: '#fecdd3',
                      fontSize: '0.8rem',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <span>{dateStr}</span>
                    {!isReadOnly && (
                      <button
                        type="button"
                        onClick={() => handleRemoveBlackoutDate(dateStr)}
                        style={{ background: 'none', border: 'none', color: '#fecdd3', cursor: 'pointer', padding: 0 }}
                        title="Remove blackout date"
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {!isReadOnly && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="date"
                  className="form-input"
                  value={newBlackoutDate}
                  onChange={(e) => setNewBlackoutDate(e.target.value)}
                  style={{ maxWidth: 180, padding: '8px 12px', fontSize: '0.8rem' }}
                />
                <button
                  type="button"
                  onClick={handleAddBlackoutDate}
                  disabled={!newBlackoutDate}
                  className="btn btn-secondary"
                  style={{ padding: '8px 14px', fontSize: '0.8rem' }}
                >
                  <Plus size={14} />
                  <span>Add Blackout</span>
                </button>
              </div>
            )}
          </div>

          {/* Holidays List */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Boutique Holidays ({formData.holidays.length})
            </label>

            {formData.holidays.length === 0 ? (
              <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)', marginBottom: 10 }}>
                No holidays recorded.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {formData.holidays.map((h) => (
                  <div
                    key={h.date + h.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid var(--border-color)',
                      fontSize: '0.825rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-gold)' }}>
                        {h.date}
                      </span>
                      <span style={{ color: '#fff', fontWeight: 500 }}>{h.name}</span>
                    </div>
                    {!isReadOnly && (
                      <button
                        type="button"
                        onClick={() => handleRemoveHoliday(h.date)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--text-muted)',
                          cursor: 'pointer',
                        }}
                        title="Delete holiday"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!isReadOnly && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="date"
                  className="form-input"
                  value={newHolidayDate}
                  onChange={(e) => setNewHolidayDate(e.target.value)}
                  style={{ maxWidth: 160, padding: '8px 12px', fontSize: '0.8rem' }}
                />
                <input
                  type="text"
                  className="form-input"
                  placeholder="Holiday Name (e.g. Diwali)"
                  value={newHolidayName}
                  onChange={(e) => setNewHolidayName(e.target.value)}
                  style={{ flex: 1, minWidth: 150, padding: '8px 12px', fontSize: '0.8rem' }}
                />
                <button
                  type="button"
                  onClick={handleAddHoliday}
                  disabled={!newHolidayDate || !newHolidayName.trim()}
                  className="btn btn-secondary"
                  style={{ padding: '8px 14px', fontSize: '0.8rem' }}
                >
                  <Plus size={14} />
                  <span>Add Holiday</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ================================================================= */}
        {/* SECTION 3: CONTACT LIMITS & PRIORITY ARBITRATION                 */}
        {/* ================================================================= */}
        <div className="glass-panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sliders size={20} color="var(--accent-emerald)" />
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>Contact Limits & Priority</h3>
              <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)' }}>
                Spec p7, p18: Caps (1/24h, 3/7d maximum), service spacing, collision ranking.
              </p>
            </div>
          </div>

          {/* Marketing Caps */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Marketing Caps (Rolling Windows)
              </label>
              <span style={{ fontSize: '0.7rem', color: 'var(--accent-gold)' }}>
                Tenant Max: 1/24h & 3/7d
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  Daily Cap (Rolling 24h)
                </span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  className="form-input"
                  disabled={isReadOnly}
                  value={formData.marketingCaps.daily}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      marketingCaps: { ...formData.marketingCaps, daily: parseInt(e.target.value, 10) || 0 },
                    })
                  }
                />
                {validationErrors['caps.daily'] && (
                  <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                    {validationErrors['caps.daily']}
                  </p>
                )}
              </div>

              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  Weekly Cap (Rolling 7d)
                </span>
                <input
                  type="number"
                  min="0"
                  max="3"
                  className="form-input"
                  disabled={isReadOnly}
                  value={formData.marketingCaps.weekly}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      marketingCaps: { ...formData.marketingCaps, weekly: parseInt(e.target.value, 10) || 0 },
                    })
                  }
                />
                {validationErrors['caps.weekly'] && (
                  <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                    {validationErrors['caps.weekly']}
                  </p>
                )}
              </div>
            </div>

            <p style={{ fontSize: '0.725rem', color: 'var(--text-muted)', marginTop: 6 }}>
              🔒 Owners may only <strong>tighten</strong> marketing limits (e.g. reduce weekly to 2), never loosen
              beyond the tenant ceiling (1/24h, 3/7d) per anti-spam policy.
            </p>

            {/* Caps Policy Summary Card (Spec p18, p25) */}
            <div
              style={{
                marginTop: 14,
                padding: '14px 16px',
                borderRadius: 10,
                background: 'rgba(99, 102, 241, 0.08)',
                border: '1px solid rgba(99, 102, 241, 0.25)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ShieldAlert size={15} color="var(--accent-indigo)" />
                  Contact Policy & Collision Summary (Spec p18)
                </span>
                <span
                  style={{
                    fontSize: '0.675rem',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: 'rgba(16, 185, 129, 0.2)',
                    color: '#34d399',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  ACTIVE ENFORCEMENT
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, fontSize: '0.75rem' }}>
                <div style={{ background: 'rgba(0, 0, 0, 0.2)', padding: '8px 10px', borderRadius: 6 }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Rolling Daily Cap:</div>
                  <strong style={{ color: '#fff' }}>{formData.marketingCaps.daily} contact / 24h</strong>
                </div>
                <div style={{ background: 'rgba(0, 0, 0, 0.2)', padding: '8px 10px', borderRadius: 6 }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Rolling Weekly Cap:</div>
                  <strong style={{ color: '#fff' }}>{formData.marketingCaps.weekly} contacts / 7d</strong>
                </div>
              </div>

              <div style={{ fontSize: '0.725rem', color: '#c7d2fe', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div>
                  • <strong>Destination-Scoped:</strong> Enforced per destination phone hash across all campaigns and duplicate customer records (e.g. household shared phones). Customer records remain strictly unmerged.
                </div>
                <div>
                  • <strong>Deterministic Collision Resolution:</strong> When marketing steps compete for a destination slot: Priority desc → Earliest expiry asc → Stable ID asc.
                </div>
                <div>
                  • <strong>Losing Step Handling:</strong> Losing steps are deferred to next available sending window (via <code>fitIntoAllowedHours</code>) or marked <code>SKIPPED_CONTACT_CAP</code> if past expiry.
                </div>
                <div>
                  • <strong>Reservation Integrity:</strong> Unresolved submissions maintain in-flight locks. Only PROVEN non-acceptance releases capacity; lease expiry alone never releases uncertain submissions.
                </div>
              </div>
            </div>
          </div>

          {/* Service Contact Spacing */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Service Contact Spacing (Hours)
            </label>
            <input
              type="number"
              min="1"
              max="720"
              className="form-input"
              disabled={isReadOnly}
              value={formData.serviceContactSpacingHours}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  serviceContactSpacingHours: parseInt(e.target.value, 10) || 24,
                })
              }
            />
            {validationErrors.serviceSpacing && (
              <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                {validationErrors.serviceSpacing}
              </p>
            )}
            <p style={{ fontSize: '0.725rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Minimum hours between customer service notifications (order status, fitting alerts).
            </p>
          </div>

          {/* Priority Collision Ranges */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 }}>
              Collision Resolution Priorities (1 - 100)
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { key: 'birthday', label: 'Birthday Occasion', def: 80 },
                { key: 'anniversary', label: 'Anniversary Occasion', def: 80 },
                { key: 'wedding', label: 'Wedding Occasion', def: 70 },
                { key: 'requestedStock', label: 'Requested Stock Alert', def: 60 },
                { key: 'festival', label: 'Festival Promotion', def: 50 },
                { key: 'winBack', label: 'Win-Back Inactivity', def: 30 },
              ].map(({ key, label }) => {
                const currentVal = formData.priorityAllowlistRanges[key] ?? 50;
                return (
                  <div
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    <span style={{ fontSize: '0.825rem', color: 'var(--text-primary)' }}>{label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        disabled={isReadOnly}
                        value={currentVal}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            priorityAllowlistRanges: {
                              ...formData.priorityAllowlistRanges,
                              [key]: parseInt(e.target.value, 10) || 1,
                            },
                          })
                        }
                        style={{
                          width: 65,
                          padding: '4px 8px',
                          background: 'rgba(15, 23, 42, 0.8)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 6,
                          color: '#fff',
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.825rem',
                          textAlign: 'center',
                        }}
                      />
                      <span
                        style={{
                          fontSize: '0.7rem',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: currentVal >= 70 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                          color: currentVal >= 70 ? '#34d399' : '#fbbf24',
                          fontWeight: 700,
                        }}
                      >
                        Rank {currentVal}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: '0.725rem', color: 'var(--text-muted)', marginTop: 8 }}>
              Spec p18: When two campaigns collide on the same customer, the step with the highest priority dispatches first.
            </p>
          </div>
        </div>

        {/* ================================================================= */}
        {/* SECTION 4: ENGINE DEFAULTS & RECOVERY POLICIES                   */}
        {/* ================================================================= */}
        <div className="glass-panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldAlert size={20} color="var(--accent-cyan)" />
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>Defaults & Policies</h3>
              <p style={{ fontSize: '0.775rem', color: 'var(--text-muted)' }}>
                Spec p7, p17: Outage grace, historical backlog and activation policies.
              </p>
            </div>
          </div>

          {/* Outage Grace */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Technical Outage Grace Period (Hours)
            </label>
            <input
              type="number"
              min="1"
              max="72"
              className="form-input"
              disabled={isReadOnly}
              value={formData.outageGraceHours}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  outageGraceHours: parseInt(e.target.value, 10) || 2,
                })
              }
            />
            {validationErrors.outageGrace && (
              <p style={{ color: 'var(--accent-rose)', fontSize: '0.75rem', marginTop: 4 }}>
                {validationErrors.outageGrace}
              </p>
            )}
            <p style={{ fontSize: '0.725rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Spec p17: Technical outage recovery window (default: 2h). Missed work beyond grace is skipped;
              bulk message bursts are prohibited.
            </p>
          </div>

          {/* Resume Policy */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Campaign Resume Policy
            </label>
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff', fontFamily: 'var(--font-mono)' }}>
                  FUTURE_ONLY
                </span>
                <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Elapsed steps during campaign pause or worker downtime are permanently skipped.
                </div>
              </div>
              <span
                style={{
                  fontSize: '0.675rem',
                  fontWeight: 700,
                  padding: '3px 8px',
                  borderRadius: 4,
                  background: 'rgba(99, 102, 241, 0.2)',
                  color: '#a5b4fc',
                }}
              >
                IMMUTABLE SPEC
              </span>
            </div>
          </div>

          {/* Import Policy */}
          <div>
            <label style={{ fontSize: '0.825rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Historical Customer Import Policy
            </label>
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fff', fontFamily: 'var(--font-mono)' }}>
                  FUTURE_ONLY
                </span>
                <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Newly imported customers join future occurrences only. No retroactive message backlog.
                </div>
              </div>
              <span
                style={{
                  fontSize: '0.675rem',
                  fontWeight: 700,
                  padding: '3px 8px',
                  borderRadius: 4,
                  background: 'rgba(99, 102, 241, 0.2)',
                  color: '#a5b4fc',
                }}
              >
                IMMUTABLE SPEC
              </span>
            </div>
          </div>

          {/* Global Pause Control (F13, Spec p20, p25) */}
          <div
            style={{
              padding: '16px',
              borderRadius: 8,
              background: formData.isPaused ? 'rgba(244, 63, 94, 0.12)' : 'rgba(16, 185, 129, 0.08)',
              border: `1px solid ${formData.isPaused ? 'rgba(244, 63, 94, 0.4)' : 'rgba(16, 185, 129, 0.3)'}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {formData.isPaused ? (
                  <AlertOctagon size={20} color="var(--accent-rose)" />
                ) : (
                  <CheckCircle2 size={20} color="var(--accent-emerald)" />
                )}
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: 700, color: '#fff' }}>
                    Tenant-Wide Emergency Dispatch Gate
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {formData.isPaused
                      ? 'Dispatch is globally frozen across all campaigns.'
                      : 'Engine active and processing scheduled submissions.'}
                  </div>
                </div>
              </div>
              <span
                style={{
                  fontSize: '0.725rem',
                  fontWeight: 700,
                  padding: '4px 10px',
                  borderRadius: 6,
                  background: formData.isPaused ? 'rgba(244, 63, 94, 0.25)' : 'rgba(16, 185, 129, 0.2)',
                  color: formData.isPaused ? '#fecdd3' : '#a7f3d0',
                  border: `1px solid ${formData.isPaused ? 'rgba(244, 63, 94, 0.4)' : 'rgba(16, 185, 129, 0.4)'}`,
                }}
              >
                {formData.isPaused ? 'GLOBALLY PAUSED' : 'ALL ACTIVE'}
              </span>
            </div>

            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                background: 'rgba(0, 0, 0, 0.25)',
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid rgba(255, 255, 255, 0.05)',
              }}
            >
              <strong style={{ color: '#fff' }}>Engine Boundary:</strong> Pausing halts evaluation and invalidates in-flight submissions via atomic CAS locks. Messages already transmitted to Meta cannot be recalled.
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              {formData.isPaused ? (
                <button
                  type="button"
                  onClick={() => handleToggleGlobalPause(false)}
                  disabled={saving}
                  className="btn btn-primary"
                  style={{
                    fontSize: '0.8rem',
                    padding: '6px 14px',
                    background: 'linear-gradient(135deg, #059669, #10b981)',
                    borderColor: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Play size={14} />
                  Resume Global Dispatch
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleToggleGlobalPause(true)}
                  disabled={saving}
                  className="btn btn-secondary"
                  style={{
                    fontSize: '0.8rem',
                    padding: '6px 14px',
                    borderColor: 'rgba(244, 63, 94, 0.4)',
                    color: '#fda4af',
                    background: 'rgba(244, 63, 94, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Pause size={14} />
                  Activate Global Emergency Pause
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

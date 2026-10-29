'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { useAuth } from '../../context/AuthContext';
import {
  Calendar,
  Gift,
  ShoppingBag,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  Lock,
  CheckCircle2,
  Plus,
  ArrowRight,
  ShieldAlert,
  Loader2,
  Clock,
  Layers,
  FileText,
  Pause,
  Play,
  Archive,
  UserCheck,
  HelpCircle,
} from 'lucide-react';
import {
  Campaign,
  CampaignPreset,
  CampaignStatus,
  IntegrationReadinessReport,
} from '@grovastra/shared';
import {
  PauseModal,
  ResumeModal,
  ArchiveModal,
} from '../../components/CampaignLifecycleModals';

export default function CampaignsPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [presets, setPresets] = useState<CampaignPreset[]>([]);
  const [readiness, setReadiness] = useState<IntegrationReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Lifecycle Modals State
  const [selectedCampaignForPause, setSelectedCampaignForPause] = useState<Campaign | null>(null);
  const [selectedCampaignForResume, setSelectedCampaignForResume] = useState<Campaign | null>(null);
  const [selectedCampaignForArchive, setSelectedCampaignForArchive] = useState<Campaign | null>(null);

  // Modal State for Creating a Campaign
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<CampaignPreset | null>(null);
  const [campaignName, setCampaignName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Route protection: If staff, immediately redirect to 403
  useEffect(() => {
    if (!authLoading && user && user.role === 'staff') {
      router.replace('/403');
    }
  }, [user, authLoading, router]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [presetsRes, campaignsRes, readinessRes] = await Promise.all([
        fetch('/api/campaign-presets'),
        fetch('/api/campaigns'),
        fetch('/api/integration/readiness'),
      ]);

      if (presetsRes.ok) {
        const presetsData = await presetsRes.json();
        setPresets(presetsData);
      }

      if (campaignsRes.ok) {
        const campaignsData = await campaignsRes.json();
        setCampaigns(campaignsData);
      }

      if (readinessRes.ok) {
        const readinessData = await readinessRes.json();
        setReadiness(readinessData);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load campaign data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user && user.role !== 'staff') {
      loadData();
    }
  }, [authLoading, user, loadData]);

  if (!authLoading && user && user.role === 'staff') {
    return null; // Will redirect to /403
  }

  const handleOpenCreateModal = (preset: CampaignPreset) => {
    setSelectedPreset(preset);
    setCampaignName(preset.defaults?.name || `${preset.name} Draft`);
    setCreateError(null);
    setModalOpen(true);
  };

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPreset) return;

    if (!campaignName.trim() || campaignName.trim().length < 3 || campaignName.trim().length > 100) {
      setCreateError('Campaign name must be between 3 and 100 characters');
      return;
    }

    try {
      setCreating(true);
      setCreateError(null);

      const idempotencyKey = `create-draft-${selectedPreset.id}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          presetId: selectedPreset.id,
          name: campaignName.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to create campaign draft');
      }

      setModalOpen(false);
      // Navigate straight to the editor wizard for the newly created campaign draft!
      router.push(`/campaigns/${data.campaign.campaignId}`);
    } catch (err: any) {
      setCreateError(err.message || 'Error creating campaign draft');
    } finally {
      setCreating(false);
    }
  };

  const getStatusBadgeClass = (status: CampaignStatus) => {
    switch (status) {
      case 'DRAFT':
        return 'badge-amber';
      case 'VALIDATED':
        return 'badge-indigo';
      case 'ACTIVE':
        return 'badge-emerald';
      case 'PAUSED':
        return 'badge-rose';
      case 'ARCHIVED':
      default:
        return 'badge-slate';
    }
  };

  const getPresetIcon = (presetId: string) => {
    switch (presetId) {
      case 'birthday':
        return Calendar;
      case 'anniversary':
      case 'gift_wedding':
      case 'gift_wedding_reminder':
        return Gift;
      case 'festival':
        return Sparkles;
      case 'win_back':
        return RefreshCw;
      case 'welcome':
      case 'welcome_new_customer':
      case 'WELCOME_NEW_CUSTOMER':
        return UserCheck;
      case 'first_to_second_purchase':
      case 'second_purchase':
      case 'FIRST_TO_SECOND_PURCHASE':
        return ShoppingBag;
      case 'unresolved_enquiry':
      case 'enquiry':
        return HelpCircle;
      case 'complete_the_outfit':
      case 'outfit_completion':
        return Sparkles;
      case 'requested_item_available':
      case 'request_stock_available':
      case 'requested_stock':
        return Clock;
      case 'matching_collection':
      case 'MATCHING_COLLECTION':
        return Sparkles;
      case 'selected_stock_promotion':
      case 'SELECTED_STOCK_PROMOTION':
        return ShoppingBag;
      default:
        return ShoppingBag;
    }
  };


  return (
    <AppShell activeTab="campaigns">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Header */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--accent-indigo)',
              }}
            >
              Owner & Admin Control
            </span>
            <span className={`badge badge-${user?.role || 'owner'}`}>{user?.role}</span>
          </div>
          <h2 style={{ fontSize: '1.85rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>
            Automatic WhatsApp Campaigns
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: 750, lineHeight: 1.5 }}>
            Activate autonomous multi-step customer occasion campaigns. The engine evaluates eligibility,
            resolves template variables, respects marketing caps and quiet hours, and stops automatically on customer reply or goal purchase.
          </p>
        </div>

        {/* Readiness Blockers Alert Banner */}
        {readiness && !readiness.ready && (
          <div
            className="glass-panel"
            style={{
              padding: '16px 20px',
              background: 'rgba(239, 68, 68, 0.08)',
              borderColor: 'rgba(239, 68, 68, 0.3)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
            }}
          >
            <ShieldAlert size={22} color="var(--accent-rose)" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: '0.875rem', lineHeight: 1.5, flex: 1 }}>
              <div style={{ fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                WhatsApp Channel Readiness Blockers
              </div>
              <div style={{ color: '#fecdd3', marginBottom: 8 }}>
                {readiness.failures.map((f, i) => (
                  <div key={i} style={{ marginBottom: 2 }}>
                    &bull; {f.message}{' '}
                    <span
                      style={{
                        fontSize: '0.7rem',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'rgba(255, 255, 255, 0.1)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      Owner: {f.fixOwner}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {readiness.notice}
              </div>
            </div>
          </div>
        )}

        {/* Hard Rule 10 Notice Banner */}
        <div
          className="glass-panel"
          style={{
            padding: '14px 18px',
            background: 'rgba(245, 158, 11, 0.08)',
            borderColor: 'rgba(245, 158, 11, 0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <AlertTriangle size={18} color="var(--accent-amber)" style={{ flexShrink: 0 }} />
          <div style={{ fontSize: '0.85rem', color: '#fef3c7', lineHeight: 1.4 }}>
            <strong style={{ color: '#fff' }}>Hard Rule #10:</strong> No preset appears as functional until its evaluator is implemented.
            Birthday, Anniversary, Win-Back, Welcome (First Visit), First-to-Second Purchase, Gift / Wedding Reminder, Unresolved Enquiry, and Complete the Outfit are active and fully operational in this release.
          </div>
        </div>

        {/* Existing Campaigns Table / Section */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff' }}>
                Configured Campaigns
              </h3>
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '3px 9px',
                  borderRadius: 12,
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-secondary)',
                  fontWeight: 600,
                }}
              >
                {campaigns.length}
              </span>
            </div>
          </div>

          {loading ? (
            <div
              className="glass-panel"
              style={{ padding: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}
            >
              <Loader2 className="animate-spin" size={24} color="var(--accent-indigo)" />
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Loading campaigns...</span>
            </div>
          ) : campaigns.length === 0 ? (
            <div
              className="glass-panel"
              style={{
                padding: 40,
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 14,
                  background: 'rgba(99, 102, 241, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--accent-indigo)',
                }}
              >
                <Layers size={26} />
              </div>
              <h4 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>No campaigns created yet</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', maxWidth: 460 }}>
                Select a preset card below to create your first multi-step WhatsApp draft with automatic eligibility and variable binding.
              </p>
            </div>
          ) : (
            <div className="glass-panel" style={{ overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '14px 20px', fontWeight: 600 }}>Campaign Name</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600 }}>Preset / Trigger</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600 }}>Status</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600 }}>Draft Version</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600 }}>Last Modified</th>
                      <th style={{ padding: '14px 20px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((cmp) => {
                      const PresetIcon = getPresetIcon(cmp.presetId);
                      return (
                        <tr
                          key={cmp.campaignId}
                          style={{
                            borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                            transition: 'background 0.2s ease',
                          }}
                        >
                          <td style={{ padding: '16px 20px' }}>
                            <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.95rem' }}>{cmp.name}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              {cmp.campaignId}
                            </div>
                          </td>
                          <td style={{ padding: '16px 20px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <PresetIcon size={16} color="var(--accent-indigo)" />
                              <span style={{ textTransform: 'capitalize', color: 'var(--text-primary)' }}>
                                {cmp.presetId}
                              </span>
                            </div>
                          </td>
                          <td style={{ padding: '16px 20px' }}>
                            <span className={`badge ${getStatusBadgeClass(cmp.status)}`}>
                              {cmp.status}
                            </span>
                          </td>
                          <td style={{ padding: '16px 20px' }}>
                            <span
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '0.8rem',
                                color: 'var(--accent-cyan)',
                                background: 'rgba(6, 182, 212, 0.1)',
                                padding: '3px 8px',
                                borderRadius: 6,
                              }}
                            >
                              v{cmp.draftVersion}
                            </span>
                          </td>
                          <td style={{ padding: '16px 20px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                            {cmp.updatedAt ? new Date(cmp.updatedAt).toLocaleDateString() : 'N/A'}
                          </td>
                          <td style={{ padding: '16px 20px', textAlign: 'right' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                              {cmp.status === 'ACTIVE' && (
                                <button
                                  onClick={() => setSelectedCampaignForPause(cmp)}
                                  className="btn btn-secondary"
                                  title="Pause Campaign"
                                  style={{
                                    fontSize: '0.8rem',
                                    padding: '6px 10px',
                                    borderColor: 'rgba(245, 158, 11, 0.4)',
                                    color: '#fbbf24',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                  }}
                                >
                                  <Pause size={13} />
                                  Pause
                                </button>
                              )}
                              {cmp.status === 'PAUSED' && (
                                <button
                                  onClick={() => setSelectedCampaignForResume(cmp)}
                                  className="btn btn-primary"
                                  title="Resume Campaign"
                                  style={{
                                    fontSize: '0.8rem',
                                    padding: '6px 10px',
                                    background: 'linear-gradient(135deg, #059669, #10b981)',
                                    borderColor: 'transparent',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                  }}
                                >
                                  <Play size={13} />
                                  Resume
                                </button>
                              )}
                              {cmp.status !== 'ARCHIVED' && (
                                <button
                                  onClick={() => setSelectedCampaignForArchive(cmp)}
                                  className="btn btn-secondary"
                                  title="Archive Campaign"
                                  style={{
                                    fontSize: '0.8rem',
                                    padding: '6px 10px',
                                    borderColor: 'rgba(244, 63, 94, 0.35)',
                                    color: '#fda4af',
                                    display: 'flex',
                                    alignItems: 'center',
                                  }}
                                >
                                  <Archive size={13} />
                                </button>
                              )}
                              <button
                                onClick={() => router.push(`/campaigns/${cmp.campaignId}`)}
                                className="btn btn-secondary"
                                style={{ fontSize: '0.8rem', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 4 }}
                              >
                                View
                                <ArrowRight size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Campaign Presets Library */}
        <div>
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff' }}>
              Preset Library
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Select an implemented preset to launch a new auto campaign workflow.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
            {presets.map((preset) => {
              const Icon = getPresetIcon(preset.id);
              const isImplemented = preset.implemented;

              return (
                <div
                  key={preset.id}
                  className="glass-panel"
                  style={{
                    padding: 24,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    opacity: isImplemented ? 1 : 0.65,
                    border: isImplemented
                      ? '1px solid rgba(99, 102, 241, 0.35)'
                      : '1px solid var(--border-color)',
                    boxShadow: isImplemented ? '0 8px 30px rgba(99, 102, 241, 0.12)' : undefined,
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 16,
                      }}
                    >
                      <div
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: 12,
                          background: isImplemented
                            ? 'rgba(99, 102, 241, 0.15)'
                            : 'rgba(255, 255, 255, 0.05)',
                          border: isImplemented
                            ? '1px solid rgba(99, 102, 241, 0.3)'
                            : '1px solid rgba(255, 255, 255, 0.1)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Icon
                          size={22}
                          color={isImplemented ? 'var(--accent-indigo)' : 'var(--text-muted)'}
                        />
                      </div>

                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: isImplemented
                            ? 'rgba(16, 185, 129, 0.15)'
                            : 'rgba(255, 255, 255, 0.05)',
                          color: isImplemented ? 'var(--accent-emerald)' : 'var(--text-muted)',
                          border: isImplemented
                            ? '1px solid rgba(16, 185, 129, 0.3)'
                            : '1px solid var(--border-color)',
                        }}
                      >
                        {isImplemented ? 'Ready to Configure' : 'Awaiting Evaluator'}
                      </span>
                    </div>

                    <h4 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                      {preset.name}
                    </h4>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
                      {preset.description}
                    </p>
                  </div>

                  <div
                    style={{
                      paddingTop: 16,
                      borderTop: '1px solid var(--border-color)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {preset.triggerFamily}
                    </span>

                    {isImplemented ? (
                      <button
                        onClick={() => handleOpenCreateModal(preset)}
                        className="btn btn-primary"
                        style={{ fontSize: '0.8rem', padding: '7px 14px' }}
                      >
                        <Plus size={15} />
                        Create Draft
                      </button>
                    ) : (
                      <button
                        disabled
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '6px 12px', opacity: 0.7 }}
                      >
                        <Lock size={13} style={{ marginRight: 4 }} />
                        Locked (Hard Rule 10)
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Create Draft Modal */}
      {modalOpen && selectedPreset && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
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
              maxWidth: 480,
              padding: 28,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-focus)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span className="badge badge-indigo">Step 1 of 5 Setup</span>
            </div>
            <h3 style={{ fontSize: '1.35rem', fontWeight: 800, color: '#fff', marginBottom: 8 }}>
              New {selectedPreset.name} Draft
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: 20 }}>
              Initialize a campaign draft. This creates an editable version in DRAFT state. Zero live sends occur.
            </p>

            <form onSubmit={handleCreateCampaign}>
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                  Campaign Name
                </label>
                <input
                  type="text"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g. Birthday Shopping Celebration"
                  minLength={3}
                  maxLength={100}
                  required
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid var(--border-color)',
                    color: '#fff',
                    fontSize: '0.9rem',
                    outline: 'none',
                  }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                  Must be 3-100 characters. Visible to boutique team.
                </span>
              </div>

              {createError && (
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#fecdd3',
                    fontSize: '0.85rem',
                    marginBottom: 20,
                  }}
                >
                  {createError}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={creating}
                  className="btn btn-secondary"
                  style={{ padding: '8px 16px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn btn-primary"
                  style={{ padding: '8px 20px' }}
                >
                  {creating ? (
                    <>
                      <Loader2 className="animate-spin" size={16} />
                      Creating Draft...
                    </>
                  ) : (
                    <>
                      Initialize Draft
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Campaign Lifecycle Modals */}
      {selectedCampaignForPause && (
        <PauseModal
          isOpen={Boolean(selectedCampaignForPause)}
          campaignId={selectedCampaignForPause.campaignId}
          campaignName={selectedCampaignForPause.name}
          onClose={() => setSelectedCampaignForPause(null)}
          onSuccess={() => {
            setSelectedCampaignForPause(null);
            loadData();
          }}
        />
      )}

      {selectedCampaignForResume && (
        <ResumeModal
          isOpen={Boolean(selectedCampaignForResume)}
          campaignId={selectedCampaignForResume.campaignId}
          campaignName={selectedCampaignForResume.name}
          onClose={() => setSelectedCampaignForResume(null)}
          onSuccess={() => {
            setSelectedCampaignForResume(null);
            loadData();
          }}
        />
      )}

      {selectedCampaignForArchive && (
        <ArchiveModal
          isOpen={Boolean(selectedCampaignForArchive)}
          campaignId={selectedCampaignForArchive.campaignId}
          campaignName={selectedCampaignForArchive.name}
          onClose={() => setSelectedCampaignForArchive(null)}
          onSuccess={() => {
            setSelectedCampaignForArchive(null);
            loadData();
          }}
        />
      )}
    </AppShell>
  );
}

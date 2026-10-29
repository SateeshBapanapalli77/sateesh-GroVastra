'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { useAuth } from '../../context/AuthContext';
import {
  Sparkles,
  Store,
  Megaphone,
  Activity,
  Users,
  ShieldCheck,
  CheckCircle2,
  Clock,
  ArrowRight,
  Lock,
} from 'lucide-react';

interface BranchItem {
  branchId: string;
  name: string;
  isMain: boolean;
  status: string;
}

interface UpcomingActivityItem {
  executionId: string;
  campaignId: string;
  campaignName: string;
  enrollmentId: string;
  customerId: string;
  customerName: string;
  maskedPhone: string;
  stepId: string;
  stepName: string;
  dueAt: string;
  localDate: string;
  localTime: string;
  timezone: string;
  state: string;
  templateId?: string | null;
  occurrenceId?: string | null;
  matchExplanation?: string | null;
}

export default function OverviewPage() {
  const { user, tenant } = useAuth();
  const router = useRouter();
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [upcomingActivities, setUpcomingActivities] = useState<UpcomingActivityItem[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(true);

  useEffect(() => {
    async function loadBranches() {
      try {
        const res = await fetch('/api/tenant/branches');
        if (res.ok) {
          const data = await res.json();
          setBranches(data.branches || []);
        }
      } catch {
        // Handle gracefully
      } finally {
        setLoadingBranches(false);
      }
    }

    async function loadActivity() {
      try {
        const res = await fetch('/api/campaigns/overview/upcoming-activity');
        if (res.ok) {
          const data = await res.json();
          setUpcomingActivities(data.activities || []);
        }
      } catch {
        // Handle gracefully
      } finally {
        setLoadingActivity(false);
      }
    }

    loadBranches();
    loadActivity();
  }, []);

  const isOwnerOrAdmin = user?.role === 'owner' || user?.role === 'admin';

  return (
    <AppShell activeTab="overview">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Welcome Banner */}
        <div
          className="glass-panel"
          style={{
            padding: '28px 32px',
            position: 'relative',
            overflow: 'hidden',
            background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.8))',
            borderColor: 'rgba(99, 102, 241, 0.25)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--accent-amber)',
                  }}
                >
                  Boutique Workspace
                </span>
                <span className={`badge badge-${user?.role || 'staff'}`}>{user?.role}</span>
              </div>

              <h2
                style={{
                  fontSize: '1.75rem',
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  color: '#fff',
                  marginBottom: 6,
                }}
              >
                Welcome back, {user?.name || user?.email}
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: 640 }}>
                Automatic WhatsApp campaign engine for <strong>{tenant?.name}</strong>. Manage
                automated customer journeys, monitor real-time audit activity, and review engagement.
              </p>
            </div>

            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(99, 102, 241, 0.2))',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Store size={26} color="var(--accent-gold)" />
            </div>
          </div>
        </div>

        {/* Info Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
          {/* Active Tenant & Branches Card */}
          <div className="glass-panel" style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Store size={18} color="var(--accent-gold)" />
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>Boutique Branches</h3>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {tenant?.tenantId}
              </span>
            </div>

            {loadingBranches ? (
              <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                Loading branches...
              </div>
            ) : branches.length === 0 ? (
              <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                No branches configured.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {branches.map((b) => (
                  <div
                    key={b.branchId}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 10,
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#fff' }}>{b.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        ID: {b.branchId}
                      </div>
                    </div>
                    {b.isMain && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          background: 'rgba(245, 158, 11, 0.15)',
                          color: '#fbbf24',
                          padding: '2px 8px',
                          borderRadius: 6,
                          fontWeight: 700,
                          border: '1px solid rgba(245, 158, 11, 0.3)',
                        }}
                      >
                        Main Flagship
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Role Access Matrix Card */}
          <div className="glass-panel" style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <ShieldCheck size={18} color="var(--accent-emerald)" />
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>Role Permissions (Spec p3, p26)</h3>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: isOwnerOrAdmin ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  border: isOwnerOrAdmin ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid var(--border-color)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>Campaign Management</span>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Activate presets, manage steps, configure template rules
                  </div>
                </div>
                {isOwnerOrAdmin ? (
                  <CheckCircle2 size={18} color="var(--accent-emerald)" />
                ) : (
                  <Lock size={16} color="var(--text-muted)" />
                )}
              </div>

              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: isOwnerOrAdmin ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  border: isOwnerOrAdmin ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid var(--border-color)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>Global Policy & Roles</span>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Configure dispatch limits, WhatsApp tokens, manage team
                  </div>
                </div>
                {isOwnerOrAdmin ? (
                  <CheckCircle2 size={18} color="var(--accent-emerald)" />
                ) : (
                  <Lock size={16} color="var(--text-muted)" />
                )}
              </div>

              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>Activity & Customer Holds</span>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    View real-time event logs and resolve customer holds
                  </div>
                </div>
                <CheckCircle2 size={18} color="var(--accent-emerald)" />
              </div>
            </div>
          </div>
        </div>

        {/* Next Scheduled Campaign Activity (Spec p17) */}
        <div className="glass-panel" style={{ padding: 24, borderLeft: '4px solid var(--accent-indigo)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: 'rgba(99, 102, 241, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Clock size={18} color="var(--accent-indigo)" />
              </div>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                  Next Scheduled Campaign Activity
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Autonomous calendar scheduler &bull; No manual sends (Spec p17, p33)
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  color: 'var(--accent-emerald)',
                  background: 'rgba(16, 185, 129, 0.1)',
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                }}
              >
                {upcomingActivities.length} Upcoming Step(s)
              </span>
              {isOwnerOrAdmin && (
                <button
                  onClick={() => router.push('/campaigns')}
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                >
                  Manage Campaigns
                  <ArrowRight size={12} />
                </button>
              )}
            </div>
          </div>

          {loadingActivity ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading scheduled activity...
            </div>
          ) : upcomingActivities.length === 0 ? (
            <div
              style={{
                padding: '24px',
                borderRadius: 10,
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px dashed rgba(255, 255, 255, 0.08)',
                textAlign: 'center',
              }}
            >
              <Clock size={28} color="var(--text-muted)" style={{ margin: '0 auto 8px', opacity: 0.6 }} />
              <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#fff', marginBottom: 4 }}>
                No Upcoming Scheduled Steps
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: 460, margin: '0 auto' }}>
                When active campaigns evaluate matching customer occasions (birthday, anniversary), scheduled message steps appear here automatically.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {upcomingActivities.map((act) => (
                <div
                  key={act.executionId}
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div
                      style={{
                        padding: '6px 10px',
                        borderRadius: 8,
                        background: 'rgba(99, 102, 241, 0.1)',
                        border: '1px solid rgba(99, 102, 241, 0.25)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        color: '#c7d2fe',
                      }}
                    >
                      {act.localDate} {act.localTime}
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff' }}>
                          {act.customerName}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {act.maskedPhone}
                        </span>
                        <span
                          style={{
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'rgba(16, 185, 129, 0.15)',
                            color: '#34d399',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                          }}
                        >
                          {act.state}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                        Campaign: <strong style={{ color: '#fff' }}>{act.campaignName}</strong> &bull; Step: <strong>{act.stepName}</strong>
                        {act.matchExplanation && ` &bull; Why selected: ${act.matchExplanation}`}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      UTC: {new Date(act.dueAt).toISOString().replace('.000Z', 'Z')}
                    </span>
                    <button
                      onClick={() => router.push(`/campaigns/${act.campaignId}`)}
                      className="btn btn-secondary"
                      style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                    >
                      View Campaign
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Feature Quick Launch Cards */}
        <div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff', marginBottom: 16 }}>
            Quick Navigation
          </h3>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {/* Campaigns Card */}
            <div
              className="glass-panel"
              style={{
                padding: 24,
                cursor: 'pointer',
                border: isOwnerOrAdmin ? '1px solid var(--border-color)' : '1px dashed rgba(255, 255, 255, 0.1)',
                opacity: isOwnerOrAdmin ? 1 : 0.85,
              }}
              onClick={() => {
                if (isOwnerOrAdmin) {
                  router.push('/campaigns');
                } else {
                  router.push('/403');
                }
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: 'rgba(99, 102, 241, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Megaphone size={20} color="var(--accent-indigo)" />
                </div>
                {!isOwnerOrAdmin && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: '0.7rem',
                      background: 'rgba(244, 63, 94, 0.15)',
                      color: '#fb7185',
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontWeight: 600,
                    }}
                  >
                    <Lock size={10} /> Locked
                  </span>
                )}
              </div>
              <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: 4 }}>Campaigns</h4>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
                Preset-driven automatic WhatsApp message triggers and stopping conditions.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--accent-indigo)', fontWeight: 600 }}>
                <span>{isOwnerOrAdmin ? 'Open Campaigns' : 'Attempt Restricted Route'}</span>
                <ArrowRight size={14} />
              </div>
            </div>

            {/* Activity Card */}
            <div
              className="glass-panel"
              style={{ padding: 24, cursor: 'pointer' }}
              onClick={() => router.push('/activity')}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: 'rgba(16, 185, 129, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Activity size={20} color="var(--accent-emerald)" />
                </div>
                <span
                  style={{
                    fontSize: '0.7rem',
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontWeight: 600,
                  }}
                >
                  All Roles
                </span>
              </div>
              <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: 4 }}>Live Activity Feed</h4>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
                Real-time append-only audit trail tracking logins, permissions, and engine events.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--accent-emerald)', fontWeight: 600 }}>
                <span>View Activity</span>
                <ArrowRight size={14} />
              </div>
            </div>

            {/* Customers Card */}
            <div
              className="glass-panel"
              style={{ padding: 24, cursor: 'pointer' }}
              onClick={() => router.push('/customers')}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: 'rgba(245, 158, 11, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Users size={20} color="var(--accent-amber)" />
                </div>
                <span
                  style={{
                    fontSize: '0.7rem',
                    background: 'rgba(245, 158, 11, 0.15)',
                    color: '#fbbf24',
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontWeight: 600,
                  }}
                >
                  All Roles
                </span>
              </div>
              <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: 4 }}>Customers</h4>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
                Eligible customers, marketing permissions, and encrypted phone records.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--accent-amber)', fontWeight: 600 }}>
                <span>View Customers</span>
                <ArrowRight size={14} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

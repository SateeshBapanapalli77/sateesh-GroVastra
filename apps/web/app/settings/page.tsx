'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { IntegrationReadiness } from '../../components/IntegrationReadiness';
import { CampaignSettingsManager } from '../../components/CampaignSettingsManager';
import { useAuth } from '../../context/AuthContext';
import {
  Settings,
  Users,
  Shield,
  Smartphone,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  RefreshCw,
} from 'lucide-react';
import { UserRole } from '@grovastra/shared';

interface TeamUser {
  _id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  name?: string;
  branchIds?: string[];
  status: string;
}

export default function SettingsPage() {
  const { user, tenant, loading } = useAuth();
  const router = useRouter();

  const [team, setTeam] = useState<TeamUser[]>([]);
  const [loadingTeam, setLoadingTeam] = useState(true);
  const [actionMessage, setActionMessage] = useState<{ text: string; isError?: boolean } | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const loadTeam = useCallback(async () => {
    try {
      setLoadingTeam(true);
      const res = await fetch('/api/tenant/users');
      if (res.ok) {
        const data = await res.json();
        setTeam(data.users || []);
      }
    } catch {
      // Handle gracefully
    } finally {
      setLoadingTeam(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      loadTeam();
    }
  }, [user, loadTeam]);

  const handleRoleChange = async (targetUserId: string, newRole: UserRole) => {
    setActionMessage(null);
    setUpdatingUserId(targetUserId);

    try {
      const res = await fetch(`/api/tenant/users/${targetUserId}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      const data = await res.json();

      if (!res.ok) {
        setActionMessage({
          text: data.error?.message || 'Failed to update user role',
          isError: true,
        });
      } else {
        setActionMessage({
          text: `Role updated to ${newRole.toUpperCase()} successfully! (Recorded in immutable audit trail)`,
          isError: false,
        });
        await loadTeam();
      }
    } catch (err: unknown) {
      setActionMessage({
        text: err instanceof Error ? err.message : 'Network error during role update',
        isError: true,
      });
    } finally {
      setUpdatingUserId(null);
    }
  };

  return (
    <AppShell activeTab="settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Header */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--accent-indigo)',
              }}
            >
              Boutique Administration
            </span>
            <span className={`badge badge-${user?.role || 'owner'}`}>{user?.role}</span>
          </div>
          <h2 style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>
            Tenant Settings & Global Policy
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Manage boutique configuration, WhatsApp dispatch channels, and team authorization matrix for{' '}
            <strong>{tenant?.name}</strong>.
          </p>
        </div>

        {actionMessage && (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 10,
              background: actionMessage.isError ? 'rgba(244, 63, 94, 0.12)' : 'rgba(16, 185, 129, 0.12)',
              border: `1px solid ${actionMessage.isError ? 'rgba(244, 63, 94, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
              color: actionMessage.isError ? '#fecdd3' : '#a7f3d0',
              fontSize: '0.875rem',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            {actionMessage.isError ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>{actionMessage.text}</span>
          </div>
        )}

        {/* Campaign Settings: Timezone, Sending Window, Blackouts, Caps & Defaults (Spec p7, p17, p18, p26) */}
        <CampaignSettingsManager userRole={user?.role} tenantName={tenant?.name} />

        {/* WhatsApp Integration Readiness & Approved Template Catalogue (Spec p3, p7, p26) */}
        <IntegrationReadiness />

        {/* Team Members & Role Management */}
        <div className="glass-panel" style={{ padding: 24 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Users size={18} color="var(--accent-indigo)" />
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
                Boutique Team Members ({team.length})
              </h3>
            </div>

            <button
              onClick={loadTeam}
              disabled={loadingTeam}
              className="btn btn-secondary"
              style={{ padding: '6px 12px', fontSize: '0.775rem' }}
            >
              <RefreshCw size={12} className={loadingTeam ? 'animate-spin' : ''} />
              <span>Refresh Team</span>
            </button>
          </div>

          {loadingTeam ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading team...</div>
          ) : team.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>No team members found.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {team.map((member) => (
                <div
                  key={member._id}
                  style={{
                    padding: '14px 18px',
                    borderRadius: 10,
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '0.925rem', fontWeight: 600, color: '#fff' }}>
                        {member.name || member.email}
                      </span>
                      <span className={`badge badge-${member.role}`}>{member.role}</span>
                      {member._id === user?.id && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>(You)</span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)', marginTop: 2 }}>
                      {member.email} · Branches: {member.branchIds?.join(', ') || 'All'}
                    </div>
                  </div>

                  {/* Role Change Controls (for Owner or Admin modifying staff) */}
                  {user?.role === 'owner' && member._id !== user.id && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Change Role:</span>
                      <select
                        value={member.role}
                        disabled={updatingUserId === member._id}
                        onChange={(e) => handleRoleChange(member._id, e.target.value as UserRole)}
                        style={{
                          background: 'rgba(15, 23, 42, 0.8)',
                          border: '1px solid var(--border-color)',
                          color: '#fff',
                          borderRadius: 8,
                          padding: '6px 10px',
                          fontSize: '0.8rem',
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="staff">Staff</option>
                        <option value="admin">Admin</option>
                        <option value="owner">Owner</option>
                      </select>
                    </div>
                  )}

                  {user?.role === 'admin' && member.role === 'staff' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        onClick={() => handleRoleChange(member._id, 'admin')}
                        disabled={updatingUserId === member._id}
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                      >
                        Promote to Admin
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

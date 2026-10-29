'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { ShieldAlert, ArrowLeft, LogOut, Lock } from 'lucide-react';

export default function ForbiddenPage() {
  const router = useRouter();
  const { user, logout } = useAuth();

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg-primary)',
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 520,
          padding: 40,
          textAlign: 'center',
          borderColor: 'rgba(244, 63, 94, 0.3)',
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            background: 'rgba(244, 63, 94, 0.15)',
            border: '1px solid rgba(244, 63, 94, 0.3)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
          }}
        >
          <Lock size={30} color="#f43f5e" />
        </div>

        <span
          className="badge"
          style={{
            background: 'rgba(244, 63, 94, 0.15)',
            color: '#fb7185',
            border: '1px solid rgba(244, 63, 94, 0.3)',
            marginBottom: 12,
          }}
        >
          HTTP 403 Forbidden
        </span>

        <h1
          style={{
            fontSize: '1.75rem',
            fontWeight: 800,
            color: '#fff',
            marginBottom: 12,
          }}
        >
          Access Restricted
        </h1>

        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '0.95rem',
            lineHeight: 1.6,
            marginBottom: 24,
          }}
        >
          Your current role (<strong style={{ color: '#fff', textTransform: 'capitalize' }}>{user?.role || 'Staff'}</strong>) does not have authorization to manage this section.
          <br />
          Per the GroVastra specification, only boutique <strong>Owners</strong> and <strong>Administrators</strong> can manage campaigns and global policy. Staff members have access to view activity and resolve customer holds.
        </p>

        <div
          style={{
            background: 'rgba(0, 0, 0, 0.25)',
            borderRadius: 10,
            padding: 16,
            marginBottom: 28,
            textAlign: 'left',
            fontSize: '0.825rem',
            fontFamily: 'var(--font-mono)',
            border: '1px solid var(--border-color)',
          }}
        >
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
            Authenticated Tenant: <span style={{ color: 'var(--text-primary)' }}>{user?.tenantId}</span>
          </div>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
            User Account: <span style={{ color: 'var(--text-primary)' }}>{user?.email}</span>
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            Permitted Roles: <span style={{ color: 'var(--accent-amber)' }}>owner, admin</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
            onClick={() => router.push('/overview')}
            className="btn btn-primary"
            style={{ padding: '10px 20px' }}
          >
            <ArrowLeft size={16} />
            <span>Return to Overview</span>
          </button>

          <button
            onClick={logout}
            className="btn btn-secondary"
            style={{ padding: '10px 18px' }}
          >
            <LogOut size={16} />
            <span>Switch User</span>
          </button>
        </div>
      </div>
    </div>
  );
}

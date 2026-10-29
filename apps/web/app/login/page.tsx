'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import { Sparkles, KeyRound, Mail, AlertCircle, ArrowRight, ShieldCheck, CheckCircle2 } from 'lucide-react';

export default function LoginPage() {
  const { login, user } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // If already logged in, redirect to overview
  React.useEffect(() => {
    if (user) {
      router.push('/overview');
    }
  }, [user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);

    const result = await login(email, password);
    setLoading(false);

    if (result.success) {
      router.push('/overview');
    } else {
      setErrorMessage(result.error || 'Authentication failed. Please verify credentials.');
    }
  };

  const fillCredentials = (userEmail: string, pass: string) => {
    setEmail(userEmail);
    setPassword(pass);
    setErrorMessage(null);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background Decorative Glow */}
      <div
        style={{
          position: 'absolute',
          top: '20%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 600,
          height: 600,
          background: 'radial-gradient(circle, rgba(99, 102, 241, 0.15) 0%, rgba(245, 158, 11, 0.05) 50%, transparent 70%)',
          filter: 'blur(60px)',
          pointerEvents: 'none',
        }}
      />

      <div style={{ width: '100%', maxWidth: 460, position: 'relative', zIndex: 10 }}>
        {/* Brand Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: 16,
              background: 'linear-gradient(135deg, #f59e0b, #6366f1)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(99, 102, 241, 0.35)',
              marginBottom: 16,
            }}
          >
            <Sparkles size={28} color="#fff" />
          </div>

          <h1
            style={{
              fontSize: '1.875rem',
              fontWeight: 800,
              letterSpacing: '-0.025em',
              background: 'linear-gradient(to right, #ffffff, #e2e8f0)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              marginBottom: 8,
            }}
          >
            GroVastra
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Auto Campaigns Engine for Handloom & Boutiques
          </p>
        </div>

        {/* Card */}
        <div className="glass-panel" style={{ padding: 32 }}>
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
              Sign In to Your Boutique
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Multi-tenant authenticated session with strict role access controls.
            </p>
          </div>

          {errorMessage && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 16px',
                borderRadius: 10,
                background: 'rgba(244, 63, 94, 0.12)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: '#fecdd3',
                fontSize: '0.85rem',
                marginBottom: 20,
              }}
            >
              <AlertCircle size={18} color="#f43f5e" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>{errorMessage}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.825rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: 8,
                }}
              >
                Email Address
              </label>
              <div style={{ position: 'relative' }}>
                <Mail
                  size={18}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. owner@shop-a.com"
                  className="form-input"
                  style={{ paddingLeft: 42 }}
                />
              </div>
            </div>

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.825rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: 8,
                }}
              >
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <KeyRound
                  size={18}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="form-input"
                  style={{ paddingLeft: 42 }}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary"
              style={{
                width: '100%',
                padding: '12px 20px',
                fontSize: '0.95rem',
                marginTop: 8,
              }}
            >
              {loading ? (
                <>
                  <div
                    className="animate-spin"
                    style={{
                      width: 16,
                      height: 16,
                      border: '2px solid rgba(255, 255, 255, 0.3)',
                      borderTopColor: '#fff',
                      borderRadius: '50%',
                    }}
                  />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {/* Quick Dev Credential Fillers */}
          <div
            style={{
              marginTop: 28,
              paddingTop: 20,
              borderTop: '1px solid var(--border-color)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  fontSize: '0.725rem',
                  fontWeight: 700,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                Dev Quick Fill (shop_a / shop_b)
              </span>
              <span
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--accent-amber)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <ShieldCheck size={12} />
                Seeded Accounts
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button
                type="button"
                onClick={() => fillCredentials('owner@shop-a.com', 'OwnerSecret#2026!')}
                className="quick-chip"
                style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <span style={{ color: '#fbbf24', fontWeight: 700 }}>Owner (shop_a)</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Full policy & campaigns</span>
              </button>

              <button
                type="button"
                onClick={() => fillCredentials('admin@shop-a.com', 'AdminSecret#2026!')}
                className="quick-chip"
                style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <span style={{ color: '#34d399', fontWeight: 700 }}>Admin (shop_a)</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Manage campaigns</span>
              </button>

              <button
                type="button"
                onClick={() => fillCredentials('staff@shop-a.com', 'StaffSecret#2026!')}
                className="quick-chip"
                style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <span style={{ color: '#818cf8', fontWeight: 700 }}>Staff (shop_a)</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>View activity / holds</span>
              </button>

              <button
                type="button"
                onClick={() => fillCredentials('owner@shop-b.com', 'ShopBSecret#2026!')}
                className="quick-chip"
                style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <span style={{ color: '#c084fc', fontWeight: 700 }}>Owner (shop_b)</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Cross-tenant test</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import {
  LayoutDashboard,
  Megaphone,
  Activity,
  Users,
  Settings,
  LogOut,
  Sparkles,
  Lock,
  Building2,
  ShieldAlert,
  HeartPulse,
  Wrench,
} from 'lucide-react';

interface AppShellProps {
  children: React.ReactNode;
  activeTab?: 'overview' | 'campaigns' | 'activity' | 'customers' | 'settings' | 'dev-tools' | 'monitoring';
}

export function AppShell({ children, activeTab }: AppShellProps) {
  const { user, tenant, logout, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // If not authenticated and not loading, redirect to login
  React.useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-primary)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            className="animate-spin"
            style={{
              width: 44,
              height: 44,
              border: '3px solid rgba(99, 102, 241, 0.2)',
              borderTopColor: 'var(--accent-indigo)',
              borderRadius: '50%',
              margin: '0 auto 16px',
            }}
          />
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Authenticating GroVastra Session...
          </p>
        </div>
      </div>
    );
  }

  const role = user.role;
  const isOwnerOrAdmin = role === 'owner' || role === 'admin';

  const menuItems = [
    {
      id: 'overview',
      name: 'Overview',
      href: '/overview',
      icon: LayoutDashboard,
      allowed: true,
      badge: null,
    },
    {
      id: 'campaigns',
      name: 'Campaigns',
      href: '/campaigns',
      icon: Megaphone,
      allowed: isOwnerOrAdmin,
      badge: !isOwnerOrAdmin ? 'Owner / Admin' : null,
    },
    {
      id: 'activity',
      name: 'Activity',
      href: '/activity',
      icon: Activity,
      allowed: true,
      badge: null,
    },
    {
      id: 'customers',
      name: 'Customers',
      href: '/customers',
      icon: Users,
      allowed: true,
      badge: null,
    },
    {
      id: 'monitoring',
      name: 'Monitoring',
      href: '/monitoring',
      icon: ShieldAlert,
      allowed: isOwnerOrAdmin,
      badge: !isOwnerOrAdmin ? 'Owner / Admin' : null,
    },
    {
      id: 'settings',
      name: 'Settings',
      href: '/settings',
      icon: Settings,
      allowed: isOwnerOrAdmin,
      badge: !isOwnerOrAdmin ? 'Owner / Admin' : null,
    },
  ];

  const handleNavClick = (item: (typeof menuItems)[0], e: React.MouseEvent) => {
    if (!item.allowed) {
      e.preventDefault();
      router.push('/403');
    } else {
      router.push(item.href);
    }
  };

  const getRoleBadgeClass = () => {
    switch (role) {
      case 'owner':
        return 'badge-owner';
      case 'admin':
        return 'badge-admin';
      case 'staff':
        return 'badge-staff';
      default:
        return 'badge-staff';
    }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-primary)' }}>
      {/* Sidebar */}
      <aside
        style={{
          width: 270,
          background: 'rgba(15, 22, 36, 0.95)',
          borderRight: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(20px)',
          padding: '24px 16px',
          position: 'sticky',
          top: 0,
          height: '100vh',
          zIndex: 40,
        }}
      >
        {/* Brand Header */}
        <div style={{ padding: '0 8px 24px 8px', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'linear-gradient(135deg, #f59e0b, #6366f1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)',
              }}
            >
              <Sparkles size={20} color="#fff" />
            </div>
            <div>
              <h1
                style={{
                  fontSize: '1.15rem',
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  background: 'linear-gradient(to right, #fff, #cbd5e1)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  lineHeight: 1.2,
                }}
              >
                GroVastra
              </h1>
              <span
                style={{
                  fontSize: '0.675rem',
                  color: 'var(--accent-amber)',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                Auto Campaigns
              </span>
            </div>
          </div>

          {/* Active Tenant Card */}
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 10,
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Building2 size={14} color="var(--accent-gold)" />
              <span
                style={{
                  fontSize: '0.825rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {tenant?.name || 'Sample Boutique'}
              </span>
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              ID: {tenant?.tenantId || user.tenantId}
            </div>
          </div>
        </div>

        {/* Navigation Menu */}
        <nav style={{ flex: 1, marginTop: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{
              fontSize: '0.675rem',
              fontWeight: 700,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              padding: '0 12px 6px',
            }}
          >
            Boutique Engine
          </div>

          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              (activeTab && activeTab === item.id) ||
              pathname === item.href ||
              (item.href !== '/overview' && pathname?.startsWith(item.href));

            return (
              <button
                key={item.id}
                onClick={(e) => handleNavClick(item, e)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: isActive
                    ? '1px solid rgba(99, 102, 241, 0.4)'
                    : '1px solid transparent',
                  background: isActive
                    ? 'linear-gradient(90deg, rgba(99, 102, 241, 0.2), rgba(99, 102, 241, 0.05))'
                    : 'transparent',
                  color: isActive
                    ? '#fff'
                    : item.allowed
                    ? 'var(--text-secondary)'
                    : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: '0.875rem',
                  fontWeight: isActive ? 600 : 500,
                  transition: 'all 0.15s ease',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                    e.currentTarget.style.color = '#fff';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = item.allowed
                      ? 'var(--text-secondary)'
                      : 'var(--text-muted)';
                  }
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Icon
                    size={18}
                    color={
                      isActive
                        ? 'var(--accent-indigo)'
                        : item.allowed
                        ? 'var(--text-secondary)'
                        : 'var(--text-muted)'
                    }
                  />
                  <span>{item.name}</span>
                </div>

                {!item.allowed && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: '0.675rem',
                      background: 'rgba(244, 63, 94, 0.15)',
                      color: '#fb7185',
                      padding: '2px 6px',
                      borderRadius: 6,
                      fontWeight: 600,
                    }}
                    title="Owner & Admin Only"
                  >
                    <Lock size={10} />
                    <span>Locked</span>
                  </span>
                )}
              </button>
            );
          })}

          <div
            style={{
              fontSize: '0.675rem',
              fontWeight: 700,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              padding: '16px 12px 6px',
            }}
          >
            System
          </div>

          <button
            onClick={() => router.push('/health')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px solid transparent',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: '0.875rem',
              fontWeight: 500,
              transition: 'all 0.15s ease',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <HeartPulse size={18} color="var(--accent-emerald)" />
            <span>Diagnostics</span>
          </button>

          {process.env.NODE_ENV !== 'production' && (
            <button
              id="nav-dev-tools"
              onClick={() => router.push('/dev-tools')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '10px 14px',
                borderRadius: 10,
                border: pathname === '/dev-tools' ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid transparent',
                background: pathname === '/dev-tools'
                  ? 'linear-gradient(90deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.04))'
                  : 'transparent',
                color: pathname === '/dev-tools' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '0.875rem',
                fontWeight: pathname === '/dev-tools' ? 600 : 500,
                transition: 'all 0.15s ease',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                if (pathname !== '/dev-tools') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                  e.currentTarget.style.color = '#fff';
                }
              }}
              onMouseLeave={(e) => {
                if (pathname !== '/dev-tools') {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--text-secondary)';
                }
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Wrench size={18} color="var(--accent-amber)" />
                <span>Dev Tools</span>
              </div>
              <span
                style={{
                  fontSize: '0.625rem',
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: 'rgba(245, 158, 11, 0.15)',
                  color: 'var(--accent-amber)',
                  fontWeight: 700,
                }}
              >
                DEV
              </span>
            </button>
          )}
        </nav>

        {/* User Card & Logout */}
        <div
          style={{
            paddingTop: 16,
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ overflow: 'hidden', paddingRight: 8 }}>
              <div
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                }}
              >
                {user.name || user.email}
              </div>
              <div
                style={{
                  fontSize: '0.725rem',
                  color: 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                }}
              >
                {user.email}
              </div>
            </div>

            <span className={`badge ${getRoleBadgeClass()}`}>{role}</span>
          </div>

          <button
            onClick={logout}
            className="btn btn-secondary"
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: '0.8rem',
              justifyContent: 'center',
            }}
          >
            <LogOut size={14} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top Header Bar */}
        <header
          style={{
            height: 64,
            borderBottom: '1px solid var(--border-color)',
            background: 'rgba(10, 13, 20, 0.7)',
            backdropFilter: 'blur(16px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 32px',
            position: 'sticky',
            top: 0,
            zIndex: 30,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Tenant: <strong style={{ color: '#fff' }}>{tenant?.name}</strong>
            </span>
            <span style={{ color: 'rgba(255, 255, 255, 0.15)' }}>|</span>
            <span
              style={{
                fontSize: '0.8rem',
                color: 'var(--accent-emerald)',
                background: 'rgba(16, 185, 129, 0.1)',
                padding: '3px 8px',
                borderRadius: 6,
                border: '1px solid rgba(16, 185, 129, 0.2)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--accent-emerald)',
                }}
              />
              Active Session
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
                background: 'rgba(255, 255, 255, 0.04)',
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-color)',
              }}
            >
              Role: <strong style={{ color: '#fff', textTransform: 'capitalize' }}>{role}</strong>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main style={{ flex: 1, padding: 32, maxWidth: 1400, width: '100%', margin: '0 auto' }}>
          {children}
        </main>
      </div>
    </div>
  );
}

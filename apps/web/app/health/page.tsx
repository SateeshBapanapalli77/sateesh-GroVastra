'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Server,
  Database,
  Clock,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Activity,
  Layers,
  ShieldCheck,
  Radio,
  Zap,
} from 'lucide-react';
import type { HealthStatus, DbHealthStatus } from '@grovastra/shared';

const API_BASE = 'http://localhost:4000';

export default function HealthDashboard() {
  const [apiHealth, setApiHealth] = useState<HealthStatus | null>(null);
  const [dbHealth, setDbHealth] = useState<DbHealthStatus | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [clockActionPending, setClockActionPending] = useState(false);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    const start = performance.now();

    // 1. Fetch API Health
    try {
      const apiRes = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
      if (!apiRes.ok) {
        throw new Error(`API returned HTTP ${apiRes.status}`);
      }
      const apiData = (await apiRes.json()) as HealthStatus;
      setApiHealth(apiData);
      setApiError(null);
      setLatencyMs(Math.round(performance.now() - start));
    } catch (err: unknown) {
      setApiHealth(null);
      setApiError(err instanceof Error ? err.message : 'Failed to reach API server');
      setLatencyMs(null);
    }

    // 2. Fetch DB Health
    try {
      const dbRes = await fetch(`${API_BASE}/health/db`, { cache: 'no-store' });
      const dbData = (await dbRes.json()) as DbHealthStatus;
      setDbHealth(dbData);
      if (dbRes.ok && dbData.status === 'connected' && dbData.isReplicaSet) {
        setDbError(null);
      } else {
        setDbError(dbData.error || (dbData.isReplicaSet === false ? 'MongoDB is not in a replica set' : 'Database disconnected'));
      }
    } catch (err: unknown) {
      setDbHealth(null);
      setDbError(err instanceof Error ? err.message : 'Database health check failed');
    } finally {
      setLoading(false);
      setLastUpdated(new Date());
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchHealth();
    }, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchHealth]);

  // Dev Clock Handlers
  const handleApplyOffset = async (offsetMs: number) => {
    setClockActionPending(true);
    try {
      const currentOffset = apiHealth?.clock?.offsetMs ?? 0;
      await fetch(`${API_BASE}/admin/clock/offset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMs: currentOffset + offsetMs }),
      });
      await fetchHealth();
    } catch (e) {
      console.error(e);
    } finally {
      setClockActionPending(false);
    }
  };

  const handleResetOffset = async () => {
    setClockActionPending(true);
    try {
      await fetch(`${API_BASE}/admin/clock/reset`, { method: 'POST' });
      await fetchHealth();
    } catch (e) {
      console.error(e);
    } finally {
      setClockActionPending(false);
    }
  };

  // Determine overall status
  const isApiUp = Boolean(apiHealth && !apiError);
  const isDbUp = Boolean(dbHealth && dbHealth.status === 'connected' && dbHealth.isReplicaSet && !dbError);
  const isAllHealthy = isApiUp && isDbUp;

  return (
    <main style={{ minHeight: '100vh', padding: '32px 20px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Top Header */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          marginBottom: '32px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #6366f1, #10b981)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(99, 102, 241, 0.3)',
            }}
          >
            <Zap size={26} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.65rem', fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>
              GroVastra <span style={{ color: 'var(--accent-indigo)', fontWeight: 500 }}>Auto Campaigns</span>
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '3px' }}>
              Core Infrastructure, MongoDB Replica Set & Transaction Engine Monitor
            </p>
          </div>
        </div>

        {/* Global Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            id="btn-auto-refresh-toggle"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className="btn btn-secondary"
            style={{
              borderColor: autoRefresh ? 'var(--accent-emerald)' : 'var(--border-color)',
              color: autoRefresh ? 'var(--accent-emerald)' : 'var(--text-muted)',
            }}
          >
            <Radio size={14} className={autoRefresh ? 'pulse-green' : ''} />
            Auto-refresh (3s): {autoRefresh ? 'ON' : 'OFF'}
          </button>

          <button
            id="btn-manual-refresh"
            onClick={fetchHealth}
            disabled={loading}
            className="btn btn-primary"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh Now
          </button>
        </div>
      </header>

      {/* Big Overall System Banner */}
      <section
        id="overall-status-banner"
        className="glass-panel"
        style={{
          padding: '20px 24px',
          marginBottom: '28px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderColor: isAllHealthy ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.4)',
          background: isAllHealthy
            ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.08), rgba(15, 23, 42, 0.6))'
            : 'linear-gradient(90deg, rgba(244, 63, 94, 0.12), rgba(15, 23, 42, 0.6))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            className={isAllHealthy ? 'pulse-green' : 'pulse-red'}
            style={{
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              backgroundColor: isAllHealthy ? 'var(--accent-emerald)' : 'var(--accent-rose)',
            }}
          />
          <div>
            <div
              id="overall-status-text"
              style={{
                fontSize: '1.15rem',
                fontWeight: 700,
                color: isAllHealthy ? 'var(--accent-emerald)' : 'var(--accent-rose)',
              }}
            >
              {isAllHealthy
                ? 'ALL SYSTEMS OPERATIONAL'
                : !isApiUp
                ? 'API SERVICE OFFLINE / UNREACHABLE'
                : 'DATABASE OFFLINE / REPLICA SET ISSUE'}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', marginTop: '2px' }}>
              {isAllHealthy
                ? 'MongoDB replica set transactions verified • Injectable Clock active • Express API healthy'
                : apiError
                ? `Connection error: ${apiError}`
                : `Database error: ${dbError}`}
            </div>
          </div>
        </div>

        <div style={{ textAlign: 'right', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
          {lastUpdated && (
            <div>
              Last checked: <span className="font-mono">{lastUpdated.toLocaleTimeString()}</span>
            </div>
          )}
          {latencyMs !== null && (
            <div style={{ marginTop: '2px' }}>
              Latency: <span className="font-mono" style={{ color: 'var(--accent-emerald)' }}>{latencyMs}ms</span>
            </div>
          )}
        </div>
      </section>

      {/* 3 Main Status Cards */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '24px',
          marginBottom: '32px',
        }}
      >
        {/* Card 1: API Server Status */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Server size={22} color="var(--accent-cyan)" />
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>API Server</h2>
            </div>
            <span
              id="api-status-badge"
              style={{
                padding: '4px 10px',
                borderRadius: '20px',
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: isApiUp ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)',
                color: isApiUp ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                border: `1px solid ${isApiUp ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`,
              }}
            >
              {isApiUp ? 'ONLINE (200 OK)' : 'OFFLINE'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.875rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Service Name:</span>
              <span className="font-mono">{apiHealth?.service ?? 'grovastra-api'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Target Port:</span>
              <span className="font-mono">4000</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Uptime:</span>
              <span className="font-mono">
                {apiHealth?.uptimeSeconds !== undefined
                  ? `${Math.floor(apiHealth.uptimeSeconds / 60)}m ${apiHealth.uptimeSeconds % 60}s`
                  : 'N/A'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Last Request ID:</span>
              <span className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--accent-indigo)' }}>
                {apiHealth?.requestId ?? '—'}
              </span>
            </div>
          </div>

          {apiError && (
            <div
              style={{
                marginTop: '16px',
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.25)',
                color: 'var(--accent-rose)',
                fontSize: '0.8125rem',
                display: 'flex',
                gap: '8px',
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
              <div>{apiError}</div>
            </div>
          )}
        </div>

        {/* Card 2: MongoDB Replica Set & Transactions */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Database size={22} color="var(--accent-emerald)" />
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>MongoDB Replica Set</h2>
            </div>
            <span
              id="db-status-badge"
              style={{
                padding: '4px 10px',
                borderRadius: '20px',
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: isDbUp ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)',
                color: isDbUp ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                border: `1px solid ${isDbUp ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`,
              }}
            >
              {isDbUp ? `PRIMARY (rs0)` : 'UNHEALTHY'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.875rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Database:</span>
              <span className="font-mono">{dbHealth?.database ?? 'grovastra_dev'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Replica Set Name:</span>
              <span className="font-mono" style={{ color: dbHealth?.replicaSetName ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
                {dbHealth?.replicaSetName ?? 'NONE (Standalone)'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Transactions:</span>
              <span
                id="transactions-status-badge"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontWeight: 600,
                  color: dbHealth?.transactionsSupported ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                }}
              >
                {dbHealth?.transactionsSupported ? (
                  <>
                    <CheckCircle2 size={14} /> SUPPORTED
                  </>
                ) : (
                  <>
                    <AlertCircle size={14} /> NOT SUPPORTED
                  </>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Active Node:</span>
              <span className="font-mono" style={{ fontSize: '0.8125rem' }}>
                {dbHealth?.hosts?.[0] ?? '127.0.0.1:27017'}
              </span>
            </div>
          </div>

          {dbError && (
            <div
              style={{
                marginTop: '16px',
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.25)',
                color: 'var(--accent-rose)',
                fontSize: '0.8125rem',
              }}
            >
              <div style={{ display: 'flex', gap: '8px', fontWeight: 600, marginBottom: '4px' }}>
                <AlertCircle size={16} /> MongoDB Replica Set Error
              </div>
              <div style={{ fontSize: '0.75rem', lineHeight: '1.4' }}>{dbError}</div>
              <div style={{ marginTop: '8px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Tip: Run <code className="font-mono">Start-Service MongoDB</code> or verify <code className="font-mono">rs.status()</code>.
              </div>
            </div>
          )}
        </div>

        {/* Card 3: Clock Service & Time Travel */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Clock size={22} color="var(--accent-indigo)" />
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Injectable Clock</h2>
            </div>
            <span
              id="clock-status-badge"
              style={{
                padding: '4px 10px',
                borderRadius: '20px',
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: apiHealth?.clock?.isDevOffsetActive
                  ? 'rgba(245, 158, 11, 0.15)'
                  : 'rgba(99, 102, 241, 0.15)',
                color: apiHealth?.clock?.isDevOffsetActive ? 'var(--accent-amber)' : 'var(--accent-indigo)',
                border: `1px solid ${
                  apiHealth?.clock?.isDevOffsetActive ? 'rgba(245, 158, 11, 0.3)' : 'rgba(99, 102, 241, 0.3)'
                }`,
              }}
            >
              {apiHealth?.clock?.isDevOffsetActive ? 'TIME SHIFTED' : 'REAL-TIME UTC'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.875rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Engine Time:</span>
              <span className="font-mono" style={{ fontSize: '0.75rem' }}>
                {apiHealth?.clock?.now ?? '—'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Offset Applied:</span>
              <span className="font-mono" style={{ color: apiHealth?.clock?.offsetMs ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                {apiHealth?.clock?.offsetMs ? `${apiHealth.clock.offsetMs / 1000}s (${apiHealth.clock.offsetMs / 3600000}h)` : '0 ms'}
              </span>
            </div>
          </div>

          {/* Dev Time Travel Quick Actions */}
          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px' }}>
              DEV TIME TRAVEL CONTROLS (SIMULATION):
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem', padding: '6px 10px' }}
                disabled={clockActionPending || !isApiUp}
                onClick={() => handleApplyOffset(3600 * 1000)}
              >
                +1 Hour
              </button>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem', padding: '6px 10px' }}
                disabled={clockActionPending || !isApiUp}
                onClick={() => handleApplyOffset(86400 * 1000)}
              >
                +1 Day
              </button>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem', padding: '6px 10px', color: 'var(--accent-rose)' }}
                disabled={clockActionPending || !isApiUp || !apiHealth?.clock?.isDevOffsetActive}
                onClick={handleResetOffset}
              >
                Reset UTC
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* System Architecture Guarantees & Invariants */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <ShieldCheck size={20} color="var(--accent-indigo)" />
          <h2 style={{ fontSize: '1rem', fontWeight: 700 }}>GroVastra Architectural Invariants (Spec Reference)</h2>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '16px',
            fontSize: '0.8125rem',
          }}
        >
          <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Multi-Document Transactions
            </div>
            <p style={{ color: 'var(--text-muted)', lineHeight: '1.4' }}>
              Transactions are required for atomic campaign publishing, occurrence claiming, and execution dispatch (Spec p3, p25).
            </p>
          </div>

          <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Tenant Isolation
            </div>
            <p style={{ color: 'var(--text-muted)', lineHeight: '1.4' }}>
              Strict tenantId on every collection, query, and compound index. Tenant comes exclusively from auth (Spec p10).
            </p>
          </div>

          <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Mongo-Backed Scheduler
            </div>
            <p style={{ color: 'var(--text-muted)', lineHeight: '1.4' }}>
              Durable execution jobs stored in MongoDB. Never use setTimeout per future message, NO Redis required (Spec p18).
            </p>
          </div>

          <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              WhatsApp Channel Only
            </div>
            <p style={{ color: 'var(--text-muted)', lineHeight: '1.4' }}>
              Provider HTTP calls never occur inside Mongo transaction callbacks. Test sandbox guards active (Spec p28).
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

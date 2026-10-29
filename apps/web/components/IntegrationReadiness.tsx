'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  FileText,
  Shield,
  Smartphone,
  Info,
  Check,
  Search,
  Filter,
  Sparkles,
  Lock,
} from 'lucide-react';
import {
  IntegrationReadinessReport,
  TemplateCatalogueResponse,
  SourceTemplate,
} from '@grovastra/shared';

export function IntegrationReadiness() {
  const [readiness, setReadiness] = useState<IntegrationReadinessReport | null>(null);
  const [catalogue, setCatalogue] = useState<TemplateCatalogueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters for template list
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [sendableFilter, setSendableFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const fetchReadinessAndTemplates = useCallback(async () => {
    try {
      setRefreshing(true);
      setError(null);

      const [readinessRes, catalogueRes] = await Promise.all([
        fetch('/api/integration/readiness'),
        fetch('/api/approved-template-catalogue'),
      ]);

      if (!readinessRes.ok) {
        throw new Error(`Failed to load readiness status (${readinessRes.status})`);
      }
      if (!catalogueRes.ok) {
        throw new Error(`Failed to load template catalogue (${catalogueRes.status})`);
      }

      const readinessData = await readinessRes.json();
      const catalogueData = await catalogueRes.json();

      setReadiness(readinessData);
      setCatalogue(catalogueData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch integration status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchReadinessAndTemplates();
  }, [fetchReadinessAndTemplates]);

  // Filter templates
  const filteredTemplates = (catalogue?.templates || []).filter((tpl: SourceTemplate) => {
    if (categoryFilter !== 'ALL' && tpl.category !== categoryFilter) return false;
    if (sendableFilter === 'SENDABLE' && !tpl.sendable) return false;
    if (sendableFilter === 'DUMMY' && tpl.sendable) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchesName = tpl.name.toLowerCase().includes(q);
      const matchesLang = tpl.language.toLowerCase().includes(q);
      const matchesBody = tpl.bodyText ? tpl.bodyText.toLowerCase().includes(q) : false;
      if (!matchesName && !matchesLang && !matchesBody) return false;
    }
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Required Spec Notice (Spec p3, p7, p26) */}
      <div
        style={{
          padding: '16px 20px',
          borderRadius: 14,
          background: 'rgba(99, 102, 241, 0.08)',
          border: '1px solid rgba(99, 102, 241, 0.25)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
        }}
      >
        <div
          style={{
            padding: 8,
            borderRadius: 10,
            background: 'rgba(99, 102, 241, 0.16)',
            color: 'var(--accent-indigo)',
            marginTop: 2,
          }}
        >
          <Info size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--accent-indigo)',
              marginBottom: 4,
            }}
          >
            WhatsApp Architecture Notice
          </div>
          <p
            style={{
              fontSize: '0.925rem',
              lineHeight: 1.5,
              color: 'var(--text-primary)',
              fontWeight: 500,
            }}
          >
            This module runs auto campaigns using an existing WhatsApp connection and approved templates.
            WhatsApp setup and template approval are managed by the integration developer.
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginTop: 10,
              fontSize: '0.775rem',
              color: 'var(--text-muted)',
            }}
          >
            <span>• Token entry disabled in UI</span>
            <span>• Template authoring managed externally</span>
            <span>• Read-only approved catalogue</span>
          </div>
        </div>
      </div>

      {/* Integration Readiness Panel */}
      <div className="glass-panel" style={{ padding: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 14,
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: readiness?.ready
                  ? 'rgba(16, 185, 129, 0.15)'
                  : 'rgba(244, 63, 94, 0.15)',
                color: readiness?.ready ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Smartphone size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>
                  WhatsApp Integration Readiness
                </h3>
                {readiness && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 20,
                      fontSize: '0.725rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      background: readiness.ready
                        ? 'rgba(16, 185, 129, 0.18)'
                        : 'rgba(244, 63, 94, 0.18)',
                      border: `1px solid ${
                        readiness.ready ? 'rgba(16, 185, 129, 0.4)' : 'rgba(244, 63, 94, 0.4)'
                      }`,
                      color: readiness.ready ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: readiness.ready ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                      }}
                      className={readiness.ready ? 'pulse-green' : 'pulse-red'}
                    />
                    {readiness.ready ? 'Ready to Dispatch' : 'Not Ready'}
                  </span>
                )}
              </div>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                Real-time validation of WhatsApp Cloud API credentials, pinned graph version, and verified test allowlist.
              </p>
            </div>
          </div>

          <button
            onClick={fetchReadinessAndTemplates}
            disabled={refreshing}
            className="btn btn-secondary"
            style={{ padding: '8px 14px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            <span>Re-check Readiness</span>
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            Checking WhatsApp connection and environment configuration...
          </div>
        ) : error ? (
          <div
            style={{
              padding: 16,
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
            <span>{error}</span>
          </div>
        ) : readiness ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Top Status Banner */}
            <div
              style={{
                padding: '16px 20px',
                borderRadius: 12,
                background: readiness.ready
                  ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.12) 0%, rgba(6, 182, 212, 0.08) 100%)'
                  : 'linear-gradient(90deg, rgba(244, 63, 94, 0.14) 0%, rgba(245, 158, 11, 0.08) 100%)',
                border: `1px solid ${
                  readiness.ready ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)'
                }`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {readiness.ready ? (
                  <CheckCircle2 size={24} color="var(--accent-emerald)" />
                ) : (
                  <XCircle size={24} color="var(--accent-rose)" />
                )}
                <div>
                  <div
                    style={{
                      fontSize: '0.975rem',
                      fontWeight: 700,
                      color: readiness.ready ? '#a7f3d0' : '#fecdd3',
                    }}
                  >
                    {readiness.ready
                      ? 'WhatsApp Channel Ready for Auto Campaigns'
                      : 'WhatsApp Dispatch Blocked – Environment Action Required'}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                    {readiness.ready
                      ? 'Connection active, token environment variable verified, sandbox allowlist ready.'
                      : `${readiness.failures.length} issue(s) detected preventing campaign execution.`}
                  </div>
                </div>
              </div>

              {readiness.connection && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'rgba(0, 0, 0, 0.25)',
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>Phone ID:</span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>
                    {readiness.connection.phoneNumberId}
                  </span>
                  <span style={{ color: 'var(--border-color)' }}>|</span>
                  <span>Version:</span>
                  <span style={{ color: 'var(--accent-gold)', fontWeight: 600 }}>
                    {readiness.connection.graphApiVersion}
                  </span>
                </div>
              )}
            </div>

            {/* Structured Failure List (if not ready) */}
            {!readiness.ready && readiness.failures.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: '16px 18px',
                  borderRadius: 12,
                  background: 'rgba(244, 63, 94, 0.05)',
                  border: '1px solid rgba(244, 63, 94, 0.2)',
                }}
              >
                <div
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--accent-rose)',
                    marginBottom: 4,
                  }}
                >
                  Required Configuration Fixes
                </div>
                {readiness.failures.map((fail, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.05)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <AlertTriangle size={16} color="var(--accent-rose)" style={{ marginTop: 2, flexShrink: 0 }} />
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span
                            style={{
                              fontSize: '0.8rem',
                              fontWeight: 700,
                              fontFamily: 'var(--font-mono)',
                              color: '#fff',
                            }}
                          >
                            {fail.code}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                          {fail.message}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'rgba(99, 102, 241, 0.15)',
                        border: '1px solid rgba(99, 102, 241, 0.3)',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: 'var(--accent-indigo)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Fix Owner: {fail.fixOwner.replace(/_/g, ' ')}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Individual Readiness Checklist Cards */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 14,
              }}
            >
              {/* Check 1: WhatsApp Connection */}
              <div
                style={{
                  padding: '16px',
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${
                    readiness.checks.connectionExists.passed
                      ? 'rgba(16, 185, 129, 0.25)'
                      : 'rgba(244, 63, 94, 0.25)'
                  }`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Connection Record
                  </span>
                  {readiness.checks.connectionExists.passed ? (
                    <CheckCircle2 size={16} color="var(--accent-emerald)" />
                  ) : (
                    <XCircle size={16} color="var(--accent-rose)" />
                  )}
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff' }}>
                  {readiness.connection ? `ID: ${readiness.connection.id}` : 'Not Configured'}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  {readiness.checks.connectionExists.message}
                </div>
              </div>

              {/* Check 2: Token SecretRef in Environment */}
              <div
                style={{
                  padding: '16px',
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${
                    readiness.checks.tokenPresent.passed
                      ? 'rgba(16, 185, 129, 0.25)'
                      : 'rgba(244, 63, 94, 0.25)'
                  }`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Token Environment Key
                  </span>
                  {readiness.checks.tokenPresent.passed ? (
                    <CheckCircle2 size={16} color="var(--accent-emerald)" />
                  ) : (
                    <XCircle size={16} color="var(--accent-rose)" />
                  )}
                </div>
                <div
                  style={{
                    fontSize: '0.875rem',
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    color: '#fff',
                  }}
                >
                  {readiness.connection?.secretRef || 'META_ACCESS_TOKEN'}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  {readiness.checks.tokenPresent.passed
                    ? 'Present in server .env (Secret protected & never exposed)'
                    : 'Missing or placeholder in server .env'}
                </div>
              </div>

              {/* Check 3: Sandbox Allowlist Guard */}
              <div
                style={{
                  padding: '16px',
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${
                    readiness.checks.allowlistConfigured.passed
                      ? 'rgba(16, 185, 129, 0.25)'
                      : 'rgba(244, 63, 94, 0.25)'
                  }`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Sandbox Allowlist Guard
                  </span>
                  {readiness.checks.allowlistConfigured.passed ? (
                    <CheckCircle2 size={16} color="var(--accent-emerald)" />
                  ) : (
                    <XCircle size={16} color="var(--accent-rose)" />
                  )}
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff' }}>
                  {readiness.checks.allowlistConfigured.count !== undefined
                    ? `${readiness.checks.allowlistConfigured.count} Verified Phone(s)`
                    : 'Unconfigured'}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  {readiness.checks.allowlistConfigured.message}
                </div>
              </div>

              {/* Check 4: Approved Sendable Templates */}
              <div
                style={{
                  padding: '16px',
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${
                    readiness.checks.hasSendableTemplate.passed
                      ? 'rgba(16, 185, 129, 0.25)'
                      : 'rgba(244, 63, 94, 0.25)'
                  }`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Sendable Templates
                  </span>
                  {readiness.checks.hasSendableTemplate.passed ? (
                    <CheckCircle2 size={16} color="var(--accent-emerald)" />
                  ) : (
                    <XCircle size={16} color="var(--accent-rose)" />
                  )}
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff' }}>
                  {readiness.sendableTemplatesCount} of {readiness.totalTemplatesCount} Templates Sendable
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  {readiness.checks.hasSendableTemplate.message}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Approved Template Catalogue Panel (Read-only) */}
      <div className="glass-panel" style={{ padding: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 16,
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'rgba(234, 179, 8, 0.15)',
                color: 'var(--accent-gold)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FileText size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>
                  Approved WhatsApp Template Catalogue
                </h3>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: 'rgba(255, 255, 255, 0.08)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Read-Only
                </span>
              </div>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                Pre-approved templates synchronized from Meta. Auto campaigns dispatch ONE approved template per step.
              </p>
            </div>
          </div>

          {/* Counts pill */}
          {catalogue && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontSize: '0.8rem',
              }}
            >
              <span
                style={{
                  padding: '4px 10px',
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.12)',
                  color: 'var(--accent-emerald)',
                  fontWeight: 600,
                }}
              >
                {catalogue.sendableCount} Meta Sendable
              </span>
              <span
                style={{
                  padding: '4px 10px',
                  borderRadius: 8,
                  background: 'rgba(234, 179, 8, 0.12)',
                  color: 'var(--accent-gold)',
                  fontWeight: 600,
                }}
              >
                {catalogue.dummyCount} Simulation / Dummy
              </span>
            </div>
          )}
        </div>

        {/* Search & Filter Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 20,
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-color)',
          }}
        >
          {/* Search Box */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              padding: '6px 12px',
              minWidth: 240,
              flex: 1,
            }}
          >
            <Search size={14} color="var(--text-muted)" />
            <input
              type="text"
              placeholder="Filter by template name or variable..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#fff',
                fontSize: '0.825rem',
                width: '100%',
              }}
            />
          </div>

          {/* Category Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Category:</span>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
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
              <option value="ALL">All Categories</option>
              <option value="MARKETING">MARKETING</option>
              <option value="UTILITY">UTILITY</option>
              <option value="UNKNOWN">UNKNOWN</option>
            </select>
          </div>

          {/* Sendable Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Status:</span>
            <select
              value={sendableFilter}
              onChange={(e) => setSendableFilter(e.target.value)}
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
              <option value="ALL">All Templates</option>
              <option value="SENDABLE">Sendable Only (Meta)</option>
              <option value="DUMMY">Dummy / Simulation Only</option>
            </select>
          </div>
        </div>

        {/* Template List */}
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading approved templates...
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            No templates match the selected filters.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {filteredTemplates.map((template: SourceTemplate) => (
              <div
                key={template.id}
                style={{
                  padding: '16px 20px',
                  borderRadius: 12,
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-color)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  transition: 'all 0.2s ease',
                }}
              >
                {/* Header row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.95rem',
                        fontWeight: 700,
                        color: '#fff',
                      }}
                    >
                      {template.name}
                    </span>
                    <span
                      style={{
                        fontSize: '0.725rem',
                        fontFamily: 'var(--font-mono)',
                        padding: '2px 8px',
                        borderRadius: 6,
                        background: 'rgba(255, 255, 255, 0.06)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {template.language}
                    </span>
                    <span
                      style={{
                        fontSize: '0.725rem',
                        padding: '2px 8px',
                        borderRadius: 6,
                        fontWeight: 600,
                        background:
                          template.category === 'MARKETING'
                            ? 'rgba(234, 179, 8, 0.15)'
                            : template.category === 'UTILITY'
                            ? 'rgba(6, 182, 212, 0.15)'
                            : 'rgba(148, 163, 184, 0.15)',
                        color:
                          template.category === 'MARKETING'
                            ? 'var(--accent-gold)'
                            : template.category === 'UTILITY'
                            ? 'var(--accent-cyan)'
                            : 'var(--text-secondary)',
                      }}
                    >
                      {template.category}
                    </span>
                    <span
                      style={{
                        fontSize: '0.725rem',
                        padding: '2px 8px',
                        borderRadius: 6,
                        fontWeight: 600,
                        background:
                          template.source === 'META_PROVIDED'
                            ? 'rgba(16, 185, 129, 0.15)'
                            : 'rgba(168, 85, 247, 0.15)',
                        color:
                          template.source === 'META_PROVIDED'
                            ? 'var(--accent-emerald)'
                            : 'var(--accent-purple)',
                      }}
                    >
                      {template.source === 'META_PROVIDED' ? 'Meta Provided' : 'Dummy / Draft'}
                    </span>
                  </div>

                  {/* Sendable Badge */}
                  <div>
                    {template.sendable ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 20,
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          background: 'rgba(16, 185, 129, 0.15)',
                          border: '1px solid rgba(16, 185, 129, 0.35)',
                          color: 'var(--accent-emerald)',
                        }}
                      >
                        <Check size={12} />
                        Sendable (Active)
                      </span>
                    ) : (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 20,
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          background: 'rgba(245, 158, 11, 0.12)',
                          border: '1px solid rgba(245, 158, 11, 0.3)',
                          color: 'var(--accent-amber)',
                        }}
                      >
                        <Lock size={12} />
                        Non-Sendable (Draft / Simulation)
                      </span>
                    )}
                  </div>
                </div>

                {/* Body Text (if dummy template) */}
                {template.bodyText && (
                  <div
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(15, 23, 42, 0.5)',
                      border: '1px solid rgba(255, 255, 255, 0.04)',
                      fontSize: '0.85rem',
                      lineHeight: 1.5,
                      color: 'var(--text-primary)',
                      fontStyle: 'italic',
                    }}
                  >
                    "{template.bodyText}"
                  </div>
                )}

                {/* Variables Schema */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8,
                    fontSize: '0.75rem',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Variables:</span>
                  {template.variables.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      No parameters (static template)
                    </span>
                  ) : (
                    template.variables.map((v) => (
                      <span
                        key={v.index}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(255, 255, 255, 0.04)',
                          border: '1px solid var(--border-color)',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <strong style={{ color: 'var(--accent-indigo)' }}>{`{{${v.index}}}`}</strong>
                        <span>{v.name}</span>
                        {v.sample && (
                          <span style={{ color: 'var(--text-muted)' }}>({v.sample})</span>
                        )}
                      </span>
                    ))
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                    Revision: {template.revision}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Security / Non-interference Notice */}
        <div
          style={{
            marginTop: 18,
            padding: '12px 16px',
            borderRadius: 8,
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid rgba(255, 255, 255, 0.04)',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={14} color="var(--accent-indigo)" />
            <span>
              Templates are provided by another team. GroVastra never creates, submits, or approves templates.
            </span>
          </div>
          <span>Source: Meta Cloud API v25.0</span>
        </div>
      </div>
    </div>
  );
}

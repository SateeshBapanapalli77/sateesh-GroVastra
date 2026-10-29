'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useAuth } from '../../context/AuthContext';
import {
  Users,
  Shield,
  Lock,
  Search,
  Filter,
  Cake,
  Calendar,
  ShoppingBag,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Tag,
  Building2,
  Sparkles,
  Phone,
  Radio,
  X,
  CreditCard,
  PackageCheck,
  RefreshCw,
  Hash,
  Eye,
  UserCheck,
  MapPin,
  Clock,
  Ban,
  Plus,
  FileText,
} from 'lucide-react';
import {
  isSuspiciousPhone,
  type SourceCustomer,
  type SourceCustomerEvent,
  type SourceOrder,
} from '@grovastra/shared';

const API_BASE = 'http://localhost:4000';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatBirthday(bday: { month: number; day: number } | null | undefined): string {
  if (!bday || !bday.month || !bday.day) return '— Not Set';
  const monthName = MONTH_NAMES[bday.month - 1] || `M${bday.month}`;
  return `${monthName} ${String(bday.day).padStart(2, '0')}`;
}

function formatPaiseToInr(paise: number | undefined | null): string {
  if (paise === undefined || paise === null) return '—';
  return (paise / 100).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  });
}

export default function CustomersPage() {
  const { user, tenant } = useAuth();

  // Customer List State
  const [customers, setCustomers] = useState<SourceCustomer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter State
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [consentFilter, setConsentFilter] = useState('ALL');
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [birthdayFilter, setBirthdayFilter] = useState('ALL');
  const [liveOnly, setLiveOnly] = useState(false);

  // Detail Drawer State
  const [selectedCustomer, setSelectedCustomer] = useState<SourceCustomer | null>(null);
  const [customerEvents, setCustomerEvents] = useState<SourceCustomerEvent[]>([]);
  const [customerOccasions, setCustomerOccasions] = useState<any[]>([]);
  const [customerOrders, setCustomerOrders] = useState<SourceOrder[]>([]);
  const [customerEnquiries, setCustomerEnquiries] = useState<any[]>([]);
  const [customerFacts, setCustomerFacts] = useState<{
    orderCount?: number;
    lastOrderAt?: string | Date;
  } | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // Visit Recording Modal State
  const [recordModalOpen, setRecordModalOpen] = useState(false);
  // Undeliverable Destinations State
  const [undeliverableHashes, setUndeliverableHashes] = useState<Set<string>>(new Set());

  // New Mock Customer Modal State
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [formFirstName, setFormFirstName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formPhoneConfirm, setFormPhoneConfirm] = useState('');
  const [formBranchId, setFormBranchId] = useState('branch_main');
  const [formMarketingOptIn, setFormMarketingOptIn] = useState(true);
  const [formConsentSource, setFormConsentSource] = useState('COUNTER_FORM');
  const [formConfirmedWithCustomer, setFormConfirmedWithCustomer] = useState(true);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createFeedback, setCreateFeedback] = useState<{
    type: 'success' | 'error' | 'warning';
    message: string;
    warnings?: string[];
  } | null>(null);

  const canVoid = user?.role === 'owner' || user?.role === 'admin';

  // Fetch Customers & Undeliverable Destination Health
  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('grovastra_auth_token');
      const params = new URLSearchParams();

      if (search.trim()) params.append('search', search.trim());
      if (statusFilter !== 'ALL') params.append('status', statusFilter);
      if (branchFilter !== 'ALL') params.append('branchId', branchFilter);
      if (liveOnly) params.append('isLive', 'true');

      if (consentFilter === 'OPTED_IN') {
        params.append('marketingOptIn', 'true');
      } else if (consentFilter === 'OPTED_OUT') {
        params.append('marketingOptIn', 'false');
      } else if (consentFilter === 'SUPPRESSED') {
        params.append('channelSuppressed', 'true');
      }

      if (birthdayFilter === 'HAS_BDAY') {
        params.append('hasBirthday', 'true');
      } else if (birthdayFilter === 'NO_BDAY') {
        params.append('hasBirthday', 'false');
      }

      params.append('includeDeleted', 'true');
      params.append('limit', '100');

      const res = await fetch(`${API_BASE}/tenant/customers?${params.toString()}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
      });

      if (!res.ok) {
        throw new Error(`Failed to load customers (HTTP ${res.status})`);
      }

      const data = await res.json();
      setCustomers(data.customers || []);
      setTotal(data.total || 0);

      // Fetch undeliverable destination health if privileged
      if (token && (user?.role === 'owner' || user?.role === 'admin')) {
        try {
          const healthRes = await fetch(`${API_BASE}/destinations/health?status=UNDELIVERABLE`, {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'include',
          });
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            const set = new Set<string>((healthData.destinations || []).map((d: any) => d.destinationHash));
            setUndeliverableHashes(set);
          }
        } catch {}
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch customer directory');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, consentFilter, branchFilter, birthdayFilter, liveOnly, user?.role]);

  const handleOpenCreateModal = () => {
    setFormFirstName('');
    setFormPhone('');
    setFormPhoneConfirm('');
    setFormBranchId('branch_main');
    setFormMarketingOptIn(true);
    setFormConsentSource('COUNTER_FORM');
    setFormConfirmedWithCustomer(true);
    setCreateFeedback(null);
    setCreateModalOpen(true);
  };

  const handleCloseCreateModal = () => {
    setCreateModalOpen(false);
    setCreateFeedback(null);
  };

  const handleSubmitCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formPhone.trim() || !formPhoneConfirm.trim()) {
      setCreateFeedback({ type: 'error', message: 'Phone and Confirm Phone are required.' });
      return;
    }
    if (formPhone.trim() !== formPhoneConfirm.trim()) {
      setCreateFeedback({ type: 'error', message: 'Phone numbers do not match.' });
      return;
    }
    setCreateSubmitting(true);
    setCreateFeedback(null);
    try {
      const token = localStorage.getItem('grovastra_auth_token');
      const res = await fetch(`${API_BASE}/dev/mock-customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          firstName: formFirstName.trim() || 'Valued Customer',
          phone: formPhone.trim(),
          phoneConfirm: formPhoneConfirm.trim(),
          branchId: formBranchId,
          marketingOptIn: formMarketingOptIn,
          consentSource: formConsentSource,
          confirmedWithCustomer: formConfirmedWithCustomer,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || `Failed to create customer (HTTP ${res.status})`);
      }
      const warnings: string[] = data.warnings || [];
      setCreateFeedback({
        type: warnings.length > 0 ? 'warning' : 'success',
        message: `Customer ${data.customer?.customerId} created successfully! (Verification: ${data.customer?.destination?.verificationLevel})`,
        warnings,
      });
      fetchCustomers();
      setTimeout(() => {
        handleCloseCreateModal();
      }, 2000);
    } catch (err) {
      setCreateFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to create mock customer',
      });
    } finally {
      setCreateSubmitting(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const refreshCustomerDetails = async (customerId: string) => {
    try {
      const token = localStorage.getItem('grovastra_auth_token');
      const headers = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const detailsRes = await fetch(`${API_BASE}/tenant/customers/${customerId}`, { headers, credentials: 'include' });
      if (detailsRes.ok) {
        const dData = await detailsRes.json();
        setCustomerFacts(dData.facts || null);
      }
    } catch (err) {
      console.error('Failed to refresh customer visits/facts:', err);
    }
  };

  // Open Drawer and load events, orders, visits, and facts
  const handleOpenDrawer = async (customer: SourceCustomer) => {
    setSelectedCustomer(customer);
    setDrawerLoading(true);
    setCustomerEvents([]);
    setCustomerOccasions([]);
    setCustomerOrders([]);
    setCustomerEnquiries([]);
    setCustomerFacts(null);

    try {
      const token = localStorage.getItem('grovastra_auth_token');
      const headers = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const [eventsRes, ordersRes, detailsRes, occasionsRes, enquiriesRes] = await Promise.all([
        fetch(`${API_BASE}/tenant/customers/${customer.customerId}/events`, {
          headers,
          credentials: 'include',
        }),
        fetch(`${API_BASE}/tenant/customers/${customer.customerId}/orders`, {
          headers,
          credentials: 'include',
        }),
        fetch(`${API_BASE}/tenant/customers/${customer.customerId}`, {
          headers,
          credentials: 'include',
        }),
        fetch(`${API_BASE}/occasions?customerId=${customer.customerId}`, {
          headers,
          credentials: 'include',
        }).catch(() => null),
        fetch(`${API_BASE}/enquiries?customerId=${customer.customerId}`, {
          headers,
          credentials: 'include',
        }).catch(() => null),
      ]);

      if (eventsRes.ok) {
        const eventsData = await eventsRes.json();
        setCustomerEvents(eventsData.events || []);
      }

      if (occasionsRes && occasionsRes.ok) {
        const occData = await occasionsRes.json();
        setCustomerOccasions(occData.occasions || []);
      }

      if (ordersRes.ok) {
        const ordersData = await ordersRes.json();
        setCustomerOrders(ordersData.orders || []);
      }

      if (enquiriesRes && enquiriesRes.ok) {
        const enqData = await enquiriesRes.json();
        setCustomerEnquiries(enqData.enquiries || []);
      }

      if (detailsRes.ok) {
        const detailsData = await detailsRes.json();
        setCustomerFacts(detailsData.facts || null);
      }
    } catch (err) {
      console.error('Failed to load customer drawer details:', err);
    } finally {
      setDrawerLoading(false);
    }
  };

  const handleCloseDrawer = () => {
    setSelectedCustomer(null);
    setCustomerEvents([]);
    setCustomerOrders([]);
    setCustomerFacts(null);
  };

  // Summary Metrics
  const liveCount = customers.filter((c) => c.isLive).length;
  const optedInCount = customers.filter((c) => c.consent?.marketingOptIn).length;
  const suppressedCount = customers.filter((c) => c.consent?.channelSuppressed).length;

  return (
    <AppShell activeTab="customers">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, position: 'relative' }}>
        {/* Top Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--accent-amber)',
                }}
              >
                Audience & Source Data
              </span>
              <span className="badge badge-staff">All Roles Access</span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: '0.75rem',
                  color: 'var(--accent-emerald)',
                  background: 'rgba(16, 185, 129, 0.1)',
                  padding: '2px 8px',
                  borderRadius: 6,
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                }}
              >
                <Shield size={12} />
                Masked Phones Enforced
              </span>
            </div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', margin: 0 }}>
              Boutique Customer Directory
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: 700, marginTop: 4 }}>
              Authoritative source customer records, encrypted destinations, date-only occasions, and order histories for{' '}
              <strong style={{ color: '#fff' }}>{tenant?.name}</strong>.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              id="btn-new-mock-customer"
              onClick={handleOpenCreateModal}
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Plus size={15} />
              New Customer (Mock CRM)
            </button>

            <button
              id="btn-refresh-customers"
              onClick={fetchCustomers}
              disabled={loading}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh Directory
            </button>
          </div>
        </div>

        {/* Metric Cards Row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          <div className="glass-panel" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Total Customers</span>
              <Users size={18} color="var(--accent-indigo)" />
            </div>
            <div id="stat-total-customers" style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fff', marginTop: 8 }}>
              {total}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Seeded in {tenant?.tenantId}
            </div>
          </div>

          <div className="glass-panel" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Live Verified (Allowlist)</span>
              <Radio size={18} color="var(--accent-emerald)" className={liveCount > 0 ? 'pulse-green' : ''} />
            </div>
            <div id="stat-live-customers" style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--accent-emerald)', marginTop: 8 }}>
              {liveCount}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
              From LIVE_CUSTOMER_PHONES
            </div>
          </div>

          <div className="glass-panel" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Marketing Opt-In</span>
              <CheckCircle2 size={18} color="var(--accent-cyan)" />
            </div>
            <div id="stat-opted-in" style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fff', marginTop: 8 }}>
              {optedInCount}{' '}
              <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                ({total > 0 ? Math.round((optedInCount / total) * 100) : 0}%)
              </span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Eligible for promotional steps
            </div>
          </div>

          <div className="glass-panel" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Channel Suppressed</span>
              <XCircle size={18} color="var(--accent-rose)" />
            </div>
            <div id="stat-suppressed" style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--accent-rose)', marginTop: 8 }}>
              {suppressedCount}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Protected by WhatsApp gate
            </div>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div
          className="glass-panel"
          style={{
            padding: 16,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(15, 23, 42, 0.75)',
          }}
        >
          {/* Search Input */}
          <div style={{ flex: '1 1 240px', position: 'relative' }}>
            <Search
              size={16}
              color="var(--text-muted)"
              style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}
            />
            <input
              id="input-customer-search"
              type="text"
              placeholder="Search by name, ID, or masked phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-field"
              style={{ paddingLeft: 36, width: '100%', fontSize: '0.85rem' }}
            />
          </div>

          {/* Consent Filter */}
          <div style={{ minWidth: 150 }}>
            <select
              id="select-consent-filter"
              value={consentFilter}
              onChange={(e) => setConsentFilter(e.target.value)}
              className="input-field"
              style={{ fontSize: '0.85rem', width: '100%' }}
            >
              <option value="ALL">All Consent States</option>
              <option value="OPTED_IN">Opted-In Only</option>
              <option value="OPTED_OUT">Opted-Out Only</option>
              <option value="SUPPRESSED">Channel Suppressed</option>
            </select>
          </div>

          {/* Birthday Filter */}
          <div style={{ minWidth: 140 }}>
            <select
              id="select-birthday-filter"
              value={birthdayFilter}
              onChange={(e) => setBirthdayFilter(e.target.value)}
              className="input-field"
              style={{ fontSize: '0.85rem', width: '100%' }}
            >
              <option value="ALL">All Birthdays</option>
              <option value="HAS_BDAY">Has Birthday</option>
              <option value="NO_BDAY">No Birthday</option>
            </select>
          </div>

          {/* Status Filter */}
          <div style={{ minWidth: 130 }}>
            <select
              id="select-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input-field"
              style={{ fontSize: '0.85rem', width: '100%' }}
            >
              <option value="ALL">All Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="DELETED">Deleted (Tombstone)</option>
            </select>
          </div>

          {/* Branch Filter */}
          <div style={{ minWidth: 150 }}>
            <select
              id="select-branch-filter"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="input-field"
              style={{ fontSize: '0.85rem', width: '100%' }}
            >
              <option value="ALL">All Branches</option>
              <option value="branch_main">Main Flagship</option>
              <option value="branch_two">Heritage Silk Lane</option>
              <option value="branch_b_main">Boutique B Flagship</option>
            </select>
          </div>

          {/* Live Allowlist Toggle Button */}
          <button
            id="btn-toggle-live-only"
            type="button"
            onClick={() => setLiveOnly(!liveOnly)}
            className="btn btn-secondary"
            style={{
              fontSize: '0.8rem',
              padding: '8px 12px',
              borderColor: liveOnly ? 'var(--accent-emerald)' : 'var(--border-color)',
              color: liveOnly ? 'var(--accent-emerald)' : 'var(--text-secondary)',
              background: liveOnly ? 'rgba(16, 185, 129, 0.12)' : 'transparent',
            }}
          >
            <Radio size={14} className={liveOnly ? 'pulse-green' : ''} />
            {liveOnly ? 'Live Verified Only: ON' : 'Live Verified Only'}
          </button>
        </div>

        {/* Error Callout */}
        {error && (
          <div
            style={{
              padding: 16,
              borderRadius: 10,
              background: 'rgba(244, 63, 94, 0.1)',
              border: '1px solid rgba(244, 63, 94, 0.3)',
              color: 'var(--accent-rose)',
              fontSize: '0.875rem',
            }}
          >
            {error}
          </div>
        )}

        {/* Customer Directory Table */}
        <div className="glass-panel" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ background: 'rgba(255, 255, 255, 0.03)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                    Customer
                  </th>
                  <th style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                    Masked Phone (Protected)
                  </th>
                  <th style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                    Birthday
                  </th>
                  <th style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                    Consent & WhatsApp Gates
                  </th>
                  <th style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                    Branch
                  </th>
                  <th style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                    Style & Weave
                  </th>
                  <th style={{ padding: '14px 18px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', textAlign: 'right' }}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                      <RefreshCw size={24} className="animate-spin" style={{ margin: '0 auto 12px' }} />
                      Loading customer directory from mock adapter...
                    </td>
                  </tr>
                ) : customers.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                      No customers match your filter criteria. Try clearing search or status filters.
                    </td>
                  </tr>
                ) : (
                  customers.map((c) => {
                    const isDeleted = c.status === 'DELETED' || Boolean(c.deletedAt);
                    const bdayFormatted = formatBirthday(c.birthday);

                    return (
                      <tr
                        key={c.customerId}
                        id={`customer-row-${c.customerId}`}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                          transition: 'background 0.15s ease',
                          opacity: isDeleted ? 0.6 : 1,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        {/* Customer Column */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div
                              style={{
                                width: 34,
                                height: 34,
                                borderRadius: 8,
                                background: c.isLive
                                  ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.3), rgba(99, 102, 241, 0.3))'
                                  : 'rgba(255, 255, 255, 0.06)',
                                border: c.isLive
                                  ? '1px solid var(--accent-emerald)'
                                  : '1px solid var(--border-color)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 700,
                                fontSize: '0.85rem',
                                color: c.isLive ? 'var(--accent-emerald)' : '#fff',
                              }}
                            >
                              {c.firstName.charAt(0)}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span>{c.firstName}</span>
                                {c.isLive ? (
                                  <span
                                    id={`badge-live-${c.customerId}`}
                                    style={{
                                      fontSize: '0.65rem',
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: 'rgba(16, 185, 129, 0.2)',
                                      color: 'var(--accent-emerald)',
                                      border: '1px solid rgba(16, 185, 129, 0.3)',
                                      fontWeight: 700,
                                      letterSpacing: '0.04em',
                                    }}
                                  >
                                    🟢 LIVE TEST
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      fontSize: '0.625rem',
                                      padding: '1px 5px',
                                      borderRadius: 4,
                                      background: 'rgba(255, 255, 255, 0.05)',
                                      color: 'var(--text-muted)',
                                      fontWeight: 600,
                                    }}
                                  >
                                    DEMO
                                  </span>
                                )}

                                {(c as any).needsStaffReview && (
                                  <span
                                    id={`badge-review-${c.customerId}`}
                                    style={{
                                      fontSize: '0.65rem',
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: 'rgba(245, 158, 11, 0.2)',
                                      color: 'var(--accent-amber)',
                                      border: '1px solid rgba(245, 158, 11, 0.4)',
                                      fontWeight: 700,
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 3,
                                    }}
                                    title={`Inbound review: ${(c as any).needsStaffReview?.reason}`}
                                  >
                                    <AlertTriangle size={10} />
                                    {(c as any).needsStaffReview?.reason === 'POSSIBLE_WRONG_NUMBER' ? 'Wrong No. Review' : 'Opt-Out Review'}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                {c.customerId}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Masked Phone Column (Hard Rule 9) */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Lock size={13} color="var(--accent-emerald)" />
                            <span
                              className="font-mono"
                              style={{
                                fontWeight: 600,
                                color: 'var(--text-primary)',
                                fontSize: '0.85rem',
                              }}
                            >
                              {c.destination?.masked || '—'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                            {undeliverableHashes.has(c.destination?.destinationHash || '') ? (
                              <span
                                id={`badge-health-undeliverable-${c.customerId}`}
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  background: 'rgba(239, 68, 68, 0.2)',
                                  color: '#f87171',
                                  border: '1px solid rgba(239, 68, 68, 0.4)',
                                  fontWeight: 700,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 3,
                                }}
                              >
                                <XCircle size={10} />
                                Undeliverable
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  background: 'rgba(16, 185, 129, 0.1)',
                                  color: 'var(--accent-emerald)',
                                  border: '1px solid rgba(16, 185, 129, 0.25)',
                                  fontWeight: 600,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 3,
                                }}
                              >
                                <CheckCircle2 size={10} />
                                Health: OK
                              </span>
                            )}

                            {(() => {
                              const vLevel = (c.destination as any)?.verificationLevel || (c.destination?.verified ? 'CONFIRMED_BY_STAFF' : 'UNVERIFIED');
                              const isConfirmed = vLevel === 'CONFIRMED_BY_STAFF' || vLevel === 'OTP_VERIFIED';
                              return (
                                <span
                                  id={`badge-vlevel-${c.customerId}`}
                                  style={{
                                    fontSize: '0.65rem',
                                    padding: '1px 6px',
                                    borderRadius: 4,
                                    background: isConfirmed ? 'rgba(16, 185, 129, 0.15)' : 'rgba(99, 102, 241, 0.15)',
                                    color: isConfirmed ? 'var(--accent-emerald)' : 'var(--accent-indigo)',
                                    border: isConfirmed ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(99, 102, 241, 0.3)',
                                    fontWeight: 600,
                                  }}
                                >
                                  {vLevel === 'CONFIRMED_BY_STAFF'
                                    ? 'Staff Confirmed'
                                    : vLevel === 'OTP_VERIFIED'
                                    ? 'OTP Verified'
                                    : vLevel === 'FORMAT_VALID'
                                    ? 'Format Valid'
                                    : 'Unverified'}
                                </span>
                              );
                            })()}
                          </div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
                            HMAC: {c.destination?.destinationHash?.slice(0, 10)}...
                          </div>
                        </td>

                        {/* Birthday Column (Date-only) */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Cake size={14} color={c.birthday ? 'var(--accent-amber)' : 'var(--text-muted)'} />
                            <span
                              style={{
                                fontWeight: c.birthday ? 600 : 400,
                                color: c.birthday ? '#fff' : 'var(--text-muted)',
                              }}
                            >
                              {bdayFormatted}
                            </span>
                          </div>
                          {c.birthday?.month === 2 && c.birthday?.day === 29 && (
                            <span style={{ fontSize: '0.65rem', color: 'var(--accent-amber)', fontWeight: 600 }}>
                              (Leap Year Fixture)
                            </span>
                          )}
                        </td>

                        {/* Consent & Suppression Badges */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {c.consent?.marketingOptIn ? (
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: 'rgba(16, 185, 129, 0.15)',
                                  color: 'var(--accent-emerald)',
                                  border: '1px solid rgba(16, 185, 129, 0.3)',
                                  fontWeight: 600,
                                }}
                              >
                                Opted In
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: 'rgba(244, 63, 94, 0.15)',
                                  color: 'var(--accent-rose)',
                                  border: '1px solid rgba(244, 63, 94, 0.3)',
                                  fontWeight: 600,
                                }}
                              >
                                Opted Out
                              </span>
                            )}

                            {(c.consent as any)?.consentSource && (
                              <span
                                id={`badge-consent-source-${c.customerId}`}
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '2px 6px',
                                  borderRadius: 6,
                                  background: 'rgba(255, 255, 255, 0.06)',
                                  color: 'var(--text-secondary)',
                                  border: '1px solid var(--border-color)',
                                  fontWeight: 600,
                                }}
                              >
                                {(c.consent as any).consentSource}
                              </span>
                            )}

                            {c.consent?.channelSuppressed && (
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: 'rgba(239, 68, 68, 0.2)',
                                  color: '#f87171',
                                  border: '1px solid rgba(239, 68, 68, 0.4)',
                                  fontWeight: 600,
                                }}
                              >
                                Suppressed
                              </span>
                            )}

                            {isDeleted && (
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: 'rgba(100, 116, 139, 0.2)',
                                  color: '#cbd5e1',
                                  border: '1px solid rgba(100, 116, 139, 0.4)',
                                  fontWeight: 600,
                                }}
                              >
                                Deleted
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Branch Column */}
                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                            <Building2 size={13} color="var(--accent-gold)" />
                            <span>
                              {c.branchId === 'branch_main'
                                ? 'Main Flagship'
                                : c.branchId === 'branch_two'
                                ? 'Silk Lane'
                                : c.branchId}
                            </span>
                          </div>
                        </td>

                        {/* Preferences Column */}
                        <td style={{ padding: '14px 18px' }}>
                          {c.preferences?.weave ? (
                            <div>
                              <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.8rem' }}>
                                {c.preferences.weave}
                              </div>
                              <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>
                                {c.preferences.colour || 'Any colour'} • Max {formatPaiseToInr(c.preferences.budgetMaxPaise)}
                              </div>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>No preference</span>
                          )}
                        </td>

                        {/* Actions Column */}
                        <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                            <button
                              id={`btn-view-${c.customerId}`}
                              onClick={() => handleOpenDrawer(c)}
                              className="btn btn-secondary"
                              style={{
                                padding: '5px 12px',
                                fontSize: '0.75rem',
                                borderColor: 'var(--border-color)',
                              }}
                            >
                              <Eye size={12} />
                              View Profile
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Slide-out Detail Drawer */}
        {selectedCustomer && (
          <div
            id="customer-detail-drawer"
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: 540,
              maxWidth: '90vw',
              background: 'rgba(15, 22, 36, 0.98)',
              backdropFilter: 'blur(24px)',
              borderLeft: '1px solid var(--border-color)',
              boxShadow: '-8px 0 32px rgba(0, 0, 0, 0.5)',
              zIndex: 100,
              display: 'flex',
              flexDirection: 'column',
              animation: 'slideInRight 0.25s ease-out',
            }}
          >
            {/* Drawer Header */}
            <div
              style={{
                padding: '24px 28px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: selectedCustomer.isLive
                      ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.4), rgba(99, 102, 241, 0.4))'
                      : 'rgba(255, 255, 255, 0.08)',
                    border: selectedCustomer.isLive
                      ? '1px solid var(--accent-emerald)'
                      : '1px solid var(--border-color)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 800,
                    fontSize: '1.1rem',
                    color: selectedCustomer.isLive ? 'var(--accent-emerald)' : '#fff',
                  }}
                >
                  {selectedCustomer.firstName.charAt(0)}
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                      {selectedCustomer.firstName}
                    </h2>
                    {selectedCustomer.isLive && (
                      <span
                        style={{
                          fontSize: '0.65rem',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'rgba(16, 185, 129, 0.2)',
                          color: 'var(--accent-emerald)',
                          border: '1px solid rgba(16, 185, 129, 0.3)',
                          fontWeight: 700,
                        }}
                      >
                        🟢 LIVE TEST
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                    ID: {selectedCustomer.customerId} • Tenant: {selectedCustomer.tenantId}
                  </div>
                </div>
              </div>

              <button
                id="btn-close-drawer"
                onClick={handleCloseDrawer}
                className="btn btn-secondary"
                style={{ padding: '6px 8px', borderRadius: 8 }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Drawer Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>
              {/* Needs Staff Review Banner if flagged */}
              {(selectedCustomer as any).needsStaffReview && (
                <div
                  id="drawer-needs-staff-review"
                  style={{
                    padding: 14,
                    borderRadius: 8,
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.4)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-amber)', fontWeight: 700, fontSize: '0.85rem' }}>
                    <AlertTriangle size={16} />
                    <span>Inbound Message Flagged for Staff Review</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#fef3c7', marginTop: 4 }}>
                    Reason: <strong>{(selectedCustomer as any).needsStaffReview.reason}</strong>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'rgba(254, 243, 199, 0.8)', marginTop: 2 }}>
                    Flagged at: {new Date((selectedCustomer as any).needsStaffReview.at).toLocaleString()} • Message ID: {(selectedCustomer as any).needsStaffReview.messageId}
                  </div>
                </div>
              )}

              {/* Security Banner (Hard Rule 9 Guarantee) */}
              <div
                style={{
                  padding: 14,
                  borderRadius: 8,
                  background: 'rgba(16, 185, 129, 0.06)',
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <Shield size={16} color="var(--accent-emerald)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-emerald)' }}>
                    Privacy & Decryption Guard (Hard Rule 9)
                  </span>
                </div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                  Phone numbers are encrypted using AES-256-GCM. Decrypted numbers are strictly guarded at rest and never exposed to staff UI or client logs.
                </p>
              </div>

              {/* Destination Details Section */}
              <div>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                  Destination & Verification
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Masked Phone</div>
                    <div className="font-mono" style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginTop: 4 }}>
                      {selectedCustomer.destination?.masked}
                    </div>
                  </div>

                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Verification Level</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent-emerald)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <CheckCircle2 size={14} />
                      {(selectedCustomer.destination as any)?.verificationLevel || (selectedCustomer.destination?.verified ? 'CONFIRMED_BY_STAFF' : 'UNVERIFIED')}
                    </div>
                    {(selectedCustomer.destination as any)?.verificationMethod && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Method: {(selectedCustomer.destination as any).verificationMethod}
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Destination Health Status</div>
                    {undeliverableHashes.has(selectedCustomer.destination?.destinationHash || '') ? (
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f87171', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <XCircle size={14} /> UNDELIVERABLE (Meta 131026)
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent-emerald)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <CheckCircle2 size={14} /> Deliverable (Health OK)
                      </div>
                    )}
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                      {undeliverableHashes.has(selectedCustomer.destination?.destinationHash || '')
                        ? 'Phone is not on WhatsApp. Pending messages across all campaigns are cancelled without auto-resend.'
                        : 'Destination passes provider deliverability gates.'}
                    </div>
                  </div>

                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Canonical Phone HMAC Hash</div>
                    <div className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--accent-indigo)', wordBreak: 'break-all', marginTop: 4 }}>
                      {selectedCustomer.destination?.destinationHash}
                    </div>
                  </div>
                </div>
              </div>

              {/* Demographics & Gate Consent */}
              <div>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                  Occasions & Gate Consent
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Cake size={12} color="var(--accent-amber)" /> Birthday (Date-Only)
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff', marginTop: 4 }}>
                      {formatBirthday(selectedCustomer.birthday)}
                    </div>
                  </div>

                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Marketing Permission</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: selectedCustomer.consent?.marketingOptIn ? 'var(--accent-emerald)' : 'var(--accent-rose)', marginTop: 4 }}>
                      {selectedCustomer.consent?.marketingOptIn ? 'Opted In (Granted)' : 'Opted Out'}
                    </div>
                  </div>

                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Consent Capture Source</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginTop: 4 }}>
                      {(selectedCustomer.consent as any)?.consentSource || 'COUNTER_FORM'}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>WhatsApp Suppression</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: selectedCustomer.consent?.channelSuppressed ? 'var(--accent-rose)' : 'var(--accent-emerald)', marginTop: 4 }}>
                      {selectedCustomer.consent?.channelSuppressed ? 'Suppressed (Blocked)' : 'Normal Channel'}
                    </div>
                  </div>

                  <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Language Preference</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff', marginTop: 4, textTransform: 'uppercase' }}>
                      {selectedCustomer.language || 'EN'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Saved Customer Events (Anniversaries) */}
              <div>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                  Saved Occasion Events (src_customerEvents)
                </h3>
                {drawerLoading ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading events...</div>
                ) : customerEvents.length === 0 ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No anniversary events recorded.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {customerEvents.map((ev) => (
                      <div
                        key={ev.eventId}
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          background: 'rgba(245, 158, 11, 0.05)',
                          border: '1px solid rgba(245, 158, 11, 0.2)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Calendar size={15} color="var(--accent-amber)" />
                          <div>
                            <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.85rem' }}>
                              {ev.label || 'Anniversary'}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              Event ID: {ev.eventId}
                            </div>
                          </div>
                        </div>
                        <span style={{ fontWeight: 700, color: 'var(--accent-amber)', fontSize: '0.85rem' }}>
                          {MONTH_NAMES[ev.month - 1]} {String(ev.day).padStart(2, '0')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Registered Occasions (GET /occasions, Spec F22) */}
              <div>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                  Registered Occasions (GET /occasions &bull; F22)
                </h3>
                {drawerLoading ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading occasions...</div>
                ) : customerOccasions.length === 0 ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No gift or wedding occasions registered.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {customerOccasions.map((occ) => (
                      <div
                        key={occ.eventId}
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          background: 'rgba(168, 85, 247, 0.05)',
                          border: '1px solid rgba(168, 85, 247, 0.2)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span
                              style={{
                                padding: '2px 8px',
                                borderRadius: 4,
                                fontSize: '0.7rem',
                                fontWeight: 800,
                                background:
                                  occ.kind === 'WEDDING'
                                    ? 'rgba(168, 85, 247, 0.2)'
                                    : 'rgba(245, 158, 11, 0.2)',
                                color: occ.kind === 'WEDDING' ? '#c084fc' : '#fbbf24',
                              }}
                            >
                              {occ.kind}
                            </span>
                            <strong style={{ color: '#fff', fontSize: '0.85rem' }}>
                              {occ.label || occ.kind}
                            </strong>
                            {occ.recipientLabel && (
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                for {occ.recipientLabel}
                              </span>
                            )}
                          </div>
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 4,
                              background:
                                occ.status === 'ACTIVE'
                                  ? 'rgba(16, 185, 129, 0.15)'
                                  : 'rgba(244, 63, 94, 0.15)',
                              color: occ.status === 'ACTIVE' ? '#34d399' : '#fb7185',
                            }}
                          >
                            {occ.status}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          <div>
                            Date: <strong style={{ color: '#fff' }}>{occ.eventDateKey || `${occ.eventDate?.year}-${occ.month}-${occ.day}`}</strong>
                          </div>
                          {occ.budgetPaise ? (
                            <div>Budget: <strong style={{ color: 'var(--accent-gold)' }}>{formatPaiseToInr(occ.budgetPaise)}</strong></div>
                          ) : null}
                        </div>

                        {occ.categories && occ.categories.length > 0 && (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                            {occ.categories.map((cat: string) => (
                              <span
                                key={cat}
                                style={{
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  fontSize: '0.65rem',
                                  background: 'rgba(255, 255, 255, 0.05)',
                                  color: 'var(--text-muted)',
                                }}
                              >
                                {cat}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Style Preferences */}
              <div>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                  Boutique Style Preferences
                </h3>
                <div style={{ padding: 14, borderRadius: 8, background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Preferred Weave</div>
                    <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.85rem', marginTop: 2 }}>
                      {selectedCustomer.preferences?.weave || 'All Weaves'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Max Budget (Minor Units)</div>
                    <div style={{ fontWeight: 600, color: 'var(--accent-gold)', fontSize: '0.85rem', marginTop: 2 }}>
                      {formatPaiseToInr(selectedCustomer.preferences?.budgetMaxPaise)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Colour Palette</div>
                    <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.85rem', marginTop: 2 }}>
                      {selectedCustomer.preferences?.colour || 'Any'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Size</div>
                    <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.85rem', marginTop: 2 }}>
                      {selectedCustomer.preferences?.size || 'Standard'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Customer Enquiries Section (Read-Only) */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>
                    Customer Inquiries (src_enquiries)
                  </h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {customerEnquiries.length} inquir{customerEnquiries.length === 1 ? 'y' : 'ies'} • Read-Only
                  </span>
                </div>

                {drawerLoading ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading inquiries...</div>
                ) : customerEnquiries.length === 0 ? (
                  <div style={{ padding: 20, textAlign: 'center', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 8, border: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      No inquiries recorded for this customer profile.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {customerEnquiries.map((enq) => (
                      <div
                        key={enq.enquiryId}
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          background: 'rgba(255, 255, 255, 0.03)',
                          border: '1px solid var(--border-color)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <strong style={{ color: '#fff', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}>
                              #{enq.enquiryId}
                            </strong>
                            <span className="badge badge-indigo" style={{ fontSize: '0.65rem' }}>{enq.channel}</span>
                            {enq.staffTakeover && (
                              <span className="badge badge-amber" style={{ fontSize: '0.65rem' }}>STAFF TAKEOVER</span>
                            )}
                          </div>
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: enq.status === 'OPEN' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.08)',
                              color: enq.status === 'OPEN' ? '#34d399' : 'var(--text-muted)',
                            }}
                          >
                            {enq.status}
                          </span>
                        </div>

                        {enq.itemRef && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            Item: <strong style={{ color: '#fff' }}>{enq.itemRef.productId}</strong>
                            {enq.itemRef.variantId && ` (${enq.itemRef.variantId})`}
                          </div>
                        )}

                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          <span>Created: {new Date(enq.createdAt).toLocaleDateString()}</span>
                          <span>Last Customer Interaction: {new Date(enq.lastCustomerInteractionAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Order History Section (src_orders) */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>
                    Order History (src_orders)
                  </h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {customerOrders.length} order{customerOrders.length === 1 ? '' : 's'}
                  </span>
                </div>

                {drawerLoading ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading order history...</div>
                ) : customerOrders.length === 0 ? (
                  <div style={{ padding: 24, textAlign: 'center', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 8, border: '1px solid var(--border-color)' }}>
                    <ShoppingBag size={24} color="var(--text-muted)" style={{ margin: '0 auto 8px' }} />
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      No orders recorded yet for this customer profile.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {customerOrders.map((ord) => {
                      const isCompleted = ord.status === 'COMPLETED';
                      const isPending = ord.status === 'PENDING';
                      const isCancelled = ord.status === 'CANCELLED';

                      return (
                        <div
                          key={ord.orderId}
                          style={{
                            padding: 14,
                            borderRadius: 8,
                            background: 'rgba(255, 255, 255, 0.03)',
                            border: '1px solid var(--border-color)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span className="font-mono" style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem' }}>
                                  {ord.orderId}
                                </span>
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    fontWeight: 700,
                                    background: isCompleted
                                      ? 'rgba(16, 185, 129, 0.2)'
                                      : isPending
                                      ? 'rgba(245, 158, 11, 0.2)'
                                      : 'rgba(244, 63, 94, 0.2)',
                                    color: isCompleted
                                      ? 'var(--accent-emerald)'
                                      : isPending
                                      ? 'var(--accent-amber)'
                                      : 'var(--accent-rose)',
                                  }}
                                >
                                  {ord.status}
                                </span>

                                {ord.occasionRef && (
                                  <span
                                    style={{
                                      fontSize: '0.65rem',
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: 'rgba(99, 102, 241, 0.2)',
                                      color: 'var(--accent-indigo)',
                                      border: '1px solid rgba(99, 102, 241, 0.3)',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Occasion: {ord.occasionRef}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)', marginTop: 4 }}>
                                {ord.completedAt
                                  ? `Completed: ${new Date(ord.completedAt).toLocaleDateString()}`
                                  : 'Pending Completion'}
                              </div>
                            </div>

                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontWeight: 800, color: '#fff', fontSize: '0.95rem' }}>
                                {formatPaiseToInr(ord.netPaise)}
                              </div>
                              <div style={{ fontSize: '0.7rem', color: ord.paid ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>
                                {ord.paid ? 'Paid' : 'Unpaid'}
                              </div>
                            </div>
                          </div>

                          {/* Line Items */}
                          {ord.lines && ord.lines.length > 0 && (
                            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
                              {ord.lines.map((line) => (
                                <div
                                  key={line.lineId}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    fontSize: '0.75rem',
                                    color: 'var(--text-secondary)',
                                  }}
                                >
                                  <span>{line.quantity}x {line.name}</span>
                                  <span className="font-mono">{formatPaiseToInr(line.pricePaise)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {/* New Customer (Mock CRM) Modal */}
        {createModalOpen && (
          <div
            id="modal-create-mock-customer"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.75)',
              backdropFilter: 'blur(8px)',
              zIndex: 200,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20,
            }}
          >
            <div
              className="glass-panel"
              style={{
                width: '100%',
                maxWidth: 520,
                padding: 28,
                background: 'rgba(15, 23, 42, 0.98)',
                border: '1px solid var(--border-color)',
                boxShadow: '0 24px 48px rgba(0,0,0,0.7)',
                maxHeight: '90vh',
                overflowY: 'auto',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 10,
                      background: 'rgba(99, 102, 241, 0.15)',
                      border: '1px solid rgba(99, 102, 241, 0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--accent-indigo)',
                    }}
                  >
                    <Users size={22} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                      New Customer (Mock CRM)
                    </h3>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>
                      Simulate counter customer entry with double-entry phone verification
                    </div>
                  </div>
                </div>
                <button
                  id="btn-close-create-modal"
                  type="button"
                  onClick={handleCloseCreateModal}
                  className="btn btn-secondary"
                  style={{ padding: '6px 8px' }}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Real-time Warning or Error Feedback */}
              {createFeedback && (
                <div
                  id="create-customer-feedback"
                  style={{
                    padding: 12,
                    borderRadius: 8,
                    marginBottom: 16,
                    fontSize: '0.825rem',
                    background:
                      createFeedback.type === 'success'
                        ? 'rgba(16, 185, 129, 0.15)'
                        : createFeedback.type === 'warning'
                        ? 'rgba(245, 158, 11, 0.15)'
                        : 'rgba(244, 63, 94, 0.15)',
                    border:
                      createFeedback.type === 'success'
                        ? '1px solid rgba(16, 185, 129, 0.3)'
                        : createFeedback.type === 'warning'
                        ? '1px solid rgba(245, 158, 11, 0.3)'
                        : '1px solid rgba(244, 63, 94, 0.3)',
                    color:
                      createFeedback.type === 'success'
                        ? 'var(--accent-emerald)'
                        : createFeedback.type === 'warning'
                        ? 'var(--accent-amber)'
                        : 'var(--accent-rose)',
                  }}
                >
                  <div>{createFeedback.message}</div>
                  {createFeedback.warnings && createFeedback.warnings.length > 0 && (
                    <div style={{ marginTop: 4, fontSize: '0.75rem', fontWeight: 600 }}>
                      Warnings: {createFeedback.warnings.join(', ')}
                    </div>
                  )}
                </div>
              )}

              <form onSubmit={handleSubmitCreateCustomer} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label htmlFor="input-customer-firstname" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                    Customer First Name
                  </label>
                  <input
                    id="input-customer-firstname"
                    type="text"
                    placeholder="e.g. Sangeetha"
                    value={formFirstName}
                    onChange={(e) => setFormFirstName(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#fff',
                      fontSize: '0.875rem',
                    }}
                  />
                </div>

                <div>
                  <label htmlFor="select-customer-branch" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                    Home Branch
                  </label>
                  <select
                    id="select-customer-branch"
                    value={formBranchId}
                    onChange={(e) => setFormBranchId(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: 8,
                      backgroundColor: '#111827',
                      border: '1px solid var(--border-color)',
                      color: '#fff',
                      fontSize: '0.875rem',
                      colorScheme: 'dark',
                    }}
                  >
                    <option value="branch_main">Main Flagship Store (branch_main)</option>
                    <option value="branch_two">Silk Lane Boutique (branch_two)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="input-customer-phone" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                    Phone Number (India / +91) *
                  </label>
                  <input
                    id="input-customer-phone"
                    type="tel"
                    placeholder="+91 98765 43210"
                    value={formPhone}
                    onChange={(e) => setFormPhone(e.target.value)}
                    required
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#fff',
                      fontSize: '0.875rem',
                    }}
                  />
                  {formPhone && isSuspiciousPhone(formPhone) && (
                    <div
                      id="banner-phone-suspicious"
                      style={{
                        marginTop: 6,
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: 'rgba(245, 158, 11, 0.15)',
                        border: '1px solid rgba(245, 158, 11, 0.35)',
                        color: 'var(--accent-amber)',
                        fontSize: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                      <span>Warning: This number has repetitive digits or a sequential pattern (PHONE_SUSPICIOUS).</span>
                    </div>
                  )}
                </div>

                <div>
                  <label htmlFor="input-customer-phone-confirm" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                    Confirm Phone Number (Double-Entry Verification) *
                  </label>
                  <input
                    id="input-customer-phone-confirm"
                    type="tel"
                    placeholder="+91 98765 43210"
                    value={formPhoneConfirm}
                    onChange={(e) => setFormPhoneConfirm(e.target.value)}
                    required
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255, 255, 255, 0.05)',
                      border:
                        formPhone && formPhoneConfirm && formPhone.trim() !== formPhoneConfirm.trim()
                          ? '1px solid rgba(244, 63, 94, 0.6)'
                          : '1px solid var(--border-color)',
                      color: '#fff',
                      fontSize: '0.875rem',
                    }}
                  />
                  {formPhone && formPhoneConfirm && formPhone.trim() !== formPhoneConfirm.trim() && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--accent-rose)', marginTop: 4, display: 'block' }}>
                      Phone numbers do not match.
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 8, background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.825rem', color: '#fff' }}>
                    <input
                      id="checkbox-confirmed-with-customer"
                      type="checkbox"
                      checked={formConfirmedWithCustomer}
                      onChange={(e) => setFormConfirmedWithCustomer(e.target.checked)}
                      style={{ width: 16, height: 16 }}
                    />
                    <span>Read back and confirmed with customer</span>
                  </label>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', paddingLeft: 24 }}>
                    {formConfirmedWithCustomer
                      ? 'Sets verification level to CONFIRMED_BY_STAFF via COUNTER_READBACK (Eligible for automated campaigns).'
                      : 'Sets verification level to FORMAT_VALID via DOUBLE_ENTRY.'}
                  </span>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.825rem', color: '#fff', marginTop: 4 }}>
                    <input
                      id="checkbox-marketing-optin"
                      type="checkbox"
                      checked={formMarketingOptIn}
                      onChange={(e) => setFormMarketingOptIn(e.target.checked)}
                      style={{ width: 16, height: 16 }}
                    />
                    <span>Marketing Opt-In (WhatsApp Channel Consent)</span>
                  </label>
                </div>

                <div>
                  <label htmlFor="select-consent-source" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#fff', marginBottom: 6 }}>
                    Consent Capture Source *
                  </label>
                  <select
                    id="select-consent-source"
                    value={formConsentSource}
                    onChange={(e) => setFormConsentSource(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: 8,
                      backgroundColor: '#111827',
                      border: '1px solid var(--border-color)',
                      color: '#fff',
                      fontSize: '0.875rem',
                      colorScheme: 'dark',
                    }}
                  >
                    <option value="COUNTER_FORM">COUNTER_FORM (Physical In-Store Form)</option>
                    <option value="VERBAL_RECORDED">VERBAL_RECORDED (Verbal Consent Recorded)</option>
                    <option value="QR">QR (In-Store QR Code Self-Opt-In)</option>
                    <option value="MOCK">MOCK (Mock CRM / Development Seed)</option>
                  </select>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                  <button
                    id="btn-cancel-create-customer"
                    type="button"
                    onClick={handleCloseCreateModal}
                    className="btn btn-secondary"
                    style={{ fontSize: '0.85rem' }}
                    disabled={createSubmitting}
                  >
                    Cancel
                  </button>
                  <button
                    id="btn-submit-create-customer"
                    type="submit"
                    className="btn btn-primary"
                    style={{
                      fontSize: '0.85rem',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    disabled={
                      createSubmitting ||
                      !formPhone.trim() ||
                      !formPhoneConfirm.trim() ||
                      formPhone.trim() !== formPhoneConfirm.trim()
                    }
                  >
                    {createSubmitting ? (
                      <>
                        <RefreshCw size={14} className="animate-spin" />
                        Creating Customer...
                      </>
                    ) : (
                      <>
                        <Plus size={14} />
                        Create Customer
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

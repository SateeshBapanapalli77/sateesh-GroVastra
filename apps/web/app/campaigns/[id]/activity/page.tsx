'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { AppShell } from '../../../../components/AppShell';
import { useAuth } from '../../../../context/AuthContext';
import { CampaignDetailView } from '../../../../components/CampaignDetailView';
import { Campaign, CampaignVersion } from '@grovastra/shared';

export default function CampaignActivityPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const campaignId = params.id as string;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [activeVersion, setActiveVersion] = useState<CampaignVersion | null>(null);
  const [draft, setDraft] = useState<CampaignVersion | null>(null);
  const [versions, setVersions] = useState<CampaignVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCampaign = useCallback(async () => {
    if (!campaignId) return;
    try {
      const [cmpRes, verRes] = await Promise.all([
        fetch(`/api/campaigns/${campaignId}`),
        fetch(`/api/campaigns/${campaignId}/versions`),
      ]);

      if (cmpRes.ok) {
        const cmpData = await cmpRes.json();
        setCampaign(cmpData.campaign);
        setActiveVersion(cmpData.activeVersion || null);
        setDraft(cmpData.draft || null);
      } else {
        setError('Failed to load campaign');
      }

      if (verRes.ok) {
        const verData = await verRes.json();
        setVersions(verData);
      }
    } catch (err: any) {
      setError(err?.message || 'Error loading campaign');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    loadCampaign();
  }, [loadCampaign]);

  if (loading || authLoading) {
    return (
      <AppShell activeTab="campaigns">
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading Campaign Activity...
        </div>
      </AppShell>
    );
  }

  if (error || !campaign) {
    return (
      <AppShell activeTab="campaigns">
        <div style={{ padding: '40px', textAlign: 'center' }}>
          <div style={{ color: 'var(--accent-rose)', marginBottom: 12 }}>
            {error || 'Campaign not found'}
          </div>
          <button onClick={() => router.push('/campaigns')} className="btn btn-secondary">
            Back to Campaigns
          </button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell activeTab="campaigns">
      <CampaignDetailView
        campaign={campaign}
        activeVersion={activeVersion}
        draft={draft}
        versions={versions}
        initialTab="activity"
        onEditCampaign={() => router.push(`/campaigns/${campaignId}`)}
        onBackToCampaigns={() => router.push('/campaigns')}
        onCampaignUpdated={loadCampaign}
      />
    </AppShell>
  );
}

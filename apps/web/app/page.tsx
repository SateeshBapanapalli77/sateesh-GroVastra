'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../context/AuthContext';

export default function RootPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading) {
      if (user) {
        router.replace('/overview');
      } else {
        router.replace('/login');
      }
    }
  }, [user, loading, router]);

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
          Loading GroVastra Engine...
        </p>
      </div>
    </div>
  );
}

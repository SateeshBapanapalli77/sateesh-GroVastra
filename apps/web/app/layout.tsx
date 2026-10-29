import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '../context/AuthContext';

export const metadata: Metadata = {
  title: 'GroVastra Auto Campaigns | Handloom & Boutique Campaign Engine',
  description:
    'Automatic WhatsApp campaign engine for handloom stores, boutiques and apparel shops.',
  keywords: ['GroVastra', 'WhatsApp Campaigns', 'Handloom', 'Boutique', 'Automation', 'Replica Set'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}


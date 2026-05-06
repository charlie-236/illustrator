import type { Metadata, Viewport } from 'next';
import './globals.css';
import '@fontsource/merriweather/400.css';
import '@fontsource/merriweather/700.css';
import '@fontsource/merriweather/400-italic.css';

export const metadata: Metadata = {
  title: 'Loom',
  description: 'Multi-modal creative workspace for stories.',
  appleWebApp: {
    capable: true,
    title: 'Loom',
    statusBarStyle: 'black-translucent',
  },
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#09090b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

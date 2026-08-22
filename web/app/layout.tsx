import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { GeistPixelGrid } from 'geist/font/pixel';
import { Analytics } from '@vercel/analytics/next';
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '../lib/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang='en'
      className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelGrid.variable}`}
    >
      {/* suppressHydrationWarning silences benign mismatches caused by browser
          extensions (Grammarly, 1Password, etc.) that mutate <body> attributes
          after the server-rendered HTML has been sent. */}
      <body className='font-sans antialiased' suppressHydrationWarning>
        {children}
        <Analytics />
      </body>
    </html>
  );
}

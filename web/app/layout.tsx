import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { GeistPixelGrid } from 'geist/font/pixel';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

export const metadata: Metadata = {
  title: 'video2ctx',
  description:
    'Connect agents to video data through one evidence-aware API and research workspace.',
  applicationName: 'video2ctx',
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

import type { Metadata } from 'next';
import { Inter, Fraunces, JetBrains_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-serif',
  axes: ['opsz', 'SOFT'],
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

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
      className={`${inter.variable} ${fraunces.variable} ${jetbrains.variable}`}
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

import type { Metadata } from 'next';
import { HOME_TITLE, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '../lib/site';
import { CraftDirection } from './_directions/craft';

export const metadata: Metadata = {
  title: HOME_TITLE,
  description: SITE_DESCRIPTION,
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
    url: '/',
    siteName: SITE_NAME,
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
  },
};

const websiteStructuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  alternateName: 'video2ctx.dev',
  url: `${SITE_URL}/`,
  description: SITE_DESCRIPTION,
  inLanguage: 'en',
};

/* The landing page went through a bake-off of seven directions, each built as a
 * complete page and compared under /explore. `craft` won, the rest were deleted
 * along with the harness, and the homepage now simply renders it. */

export default function HomePage() {
  return (
    <>
      <script
        type='application/ld+json'
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(websiteStructuredData).replace(/</g, '\\u003c'),
        }}
      />
      <CraftDirection />
    </>
  );
}

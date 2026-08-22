import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/site.ts';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: '2026-08-22',
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: '2026-08-14',
      changeFrequency: 'yearly',
      priority: 0.2,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: '2026-08-10',
      changeFrequency: 'yearly',
      priority: 0.2,
    },
  ];
}

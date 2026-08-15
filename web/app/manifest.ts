import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'video2ctx',
    short_name: 'video2ctx',
    description:
      'Turn YouTube videos into transcripts, channel data, comments, playlists, and searchable context.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#f03a36',
    icons: [
      {
        src: '/android-chrome-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/android-chrome-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };
}

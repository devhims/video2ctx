import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
  async rewrites() {
    return [
      {
        source: '/api/auth/:path*',
        destination: '/api/platform/api/auth/:path*',
      },
    ];
  },
};

export default nextConfig;

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { networkInterfaces } from 'node:os';

const lanDevOrigins = [
  ...new Set(
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => !entry.internal && entry.family === 'IPv4')
      .map((entry) => entry.address),
  ),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: lanDevOrigins,
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

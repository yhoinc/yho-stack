import type { NextConfig } from 'next';

const API = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // When NEXT_PUBLIC_API_BASE is present, proxy /documents/* to it.
  async rewrites() {
    if (!API) return [];
    return [
      {
        source: '/documents/:path*',
        destination: `${API}/documents/:path*`,
      },
    ];
  },
  // Recommended for deployment on Render/Vercel
  experimental: {
    optimizePackageImports: [],
  },
};

export default nextConfig;

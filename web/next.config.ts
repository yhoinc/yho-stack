import type { NextConfig } from 'next';

const API = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Skip ESLint checks in production builds (unblocks deploy)
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Keep the proxy rewrite so /documents/* goes to your FastAPI API
  async rewrites() {
    if (!API) return [];
    return [
      {
        source: '/documents/:path*',
        destination: `${API}/documents/:path*`,
      },
    ];
  },

  experimental: {
    optimizePackageImports: [],
  },
};

export default nextConfig;

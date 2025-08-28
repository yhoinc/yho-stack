/** @type {import('next').NextConfig} */
const API = (process.env.NEXT_PUBLIC_API_BASE || '').replace(/\/+$/, '');

const nextConfig = {
  reactStrictMode: true,

  // Unblock production builds even if ESLint finds issues
  eslint: {
    ignoreDuringBuilds: true,
  },

  async rewrites() {
    if (!API) return [];
    return [
      // Proxy documents calls to your FastAPI host
      { source: '/documents/:path*', destination: `${API}/documents/:path*` },
    ];
  },
};

module.exports = nextConfig;

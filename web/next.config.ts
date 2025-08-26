import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ignore lint/TS build errors in production deploys
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  // Rewrites so frontend can talk to FastAPI backend
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        // ⚠️ In local dev, this points to FastAPI on port 8000
        destination: "http://localhost:8000/:path*",
      },
      {
        source: "/api/:path*",
        // ⚠️ In production (Render), point this to your deployed API service
        // Replace with your actual FastAPI Render URL
        destination: process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000/:path*",
      },
    ];
  },
};

export default nextConfig;

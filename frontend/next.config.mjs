/** @type {import('next').NextConfig} */
const backendUrl = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/auth/:path*",
        destination: `${backendUrl}/auth/:path*`,
      },
      {
        source: "/users/:path*",
        destination: `${backendUrl}/users/:path*`,
      },
      {
        source: "/contacts",
        destination: `${backendUrl}/contacts`,
      },
      {
        source: "/contacts/:path*",
        destination: `${backendUrl}/contacts/:path*`,
      },
      {
        source: "/blocks",
        destination: `${backendUrl}/blocks`,
      },
      {
        source: "/blocks/:path*",
        destination: `${backendUrl}/blocks/:path*`,
      },
      {
        source: "/conversations",
        destination: `${backendUrl}/conversations`,
      },
      {
        source: "/conversations/:path*",
        destination: `${backendUrl}/conversations/:path*`,
      },
      {
        source: "/messages",
        destination: `${backendUrl}/messages`,
      },
      {
        source: "/messages/:path*",
        destination: `${backendUrl}/messages/:path*`,
      },
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/.well-known/:path*",
        destination: `${backendUrl}/.well-known/:path*`,
      },
      {
        source: "/federation/:path*",
        destination: `${backendUrl}/federation/:path*`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
      {
        source: "/docs",
        destination: `${backendUrl}/docs`,
      },
      {
        source: "/openapi.json",
        destination: `${backendUrl}/openapi.json`,
      },
    ];
  },
};

export default nextConfig;

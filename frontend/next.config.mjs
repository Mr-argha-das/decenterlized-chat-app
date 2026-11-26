/** @type {import('next').NextConfig} */
const backendUrl = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(self), payment=()",
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
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
        source: "/attachments",
        destination: `${backendUrl}/attachments`,
      },
      {
        source: "/attachments/:path*",
        destination: `${backendUrl}/attachments/:path*`,
      },
      {
        source: "/groups",
        destination: `${backendUrl}/groups`,
      },
      {
        source: "/groups/:path*",
        destination: `${backendUrl}/groups/:path*`,
      },
      {
        source: "/statuses",
        destination: `${backendUrl}/statuses`,
      },
      {
        source: "/statuses/:path*",
        destination: `${backendUrl}/statuses/:path*`,
      },
      {
        source: "/push",
        destination: `${backendUrl}/push`,
      },
      {
        source: "/push/:path*",
        destination: `${backendUrl}/push/:path*`,
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
        source: "/federation",
        destination: `${backendUrl}/federation`,
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
        source: "/metrics",
        destination: `${backendUrl}/metrics`,
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

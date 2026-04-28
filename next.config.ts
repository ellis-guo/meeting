import type { NextConfig } from "next";

// CSP: Clerk requires 'unsafe-inline' for styles and connects to clerk.com endpoints.
// DashScope calls are server-side only, so no connect-src entry needed here.
const csp = [
  "default-src 'self'",
  // Next.js inline scripts + Clerk JS (includes production custom domain)
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.com https://*.clerk.accounts.dev https://*.ellisguo.com",
  // Clerk injects inline styles
  "style-src 'self' 'unsafe-inline'",
  // Fonts loaded from Google Fonts via next/font
  "font-src 'self' data: https://fonts.gstatic.com",
  // Images: self + data URIs (avatars, icons)
  "img-src 'self' data: blob: https:",
  // Clerk creates Web Workers from blob URLs for auth
  "worker-src 'self' blob:",
  // XHR/fetch: self + Clerk auth endpoints (includes production custom domain)
  "connect-src 'self' https://clerk.com https://*.clerk.accounts.dev https://api.clerk.com https://*.ellisguo.com",
  // Clerk uses Cloudflare Turnstile (iframe) for bot protection
  "frame-src 'self' https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig: NextConfig = {
  // Exclude jieba-wasm from webpack bundling so Node.js resolves __dirname correctly
  serverExternalPackages: ["jieba-wasm"],
  // Include jieba-wasm WASM binary in Vercel serverless function bundle
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/jieba-wasm/pkg/nodejs/*.wasm"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

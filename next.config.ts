import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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

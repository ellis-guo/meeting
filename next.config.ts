import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exclude jieba-wasm from webpack bundling so Node.js resolves __dirname correctly
  serverExternalPackages: ["jieba-wasm"],
  // Include jieba-wasm WASM binary in Vercel serverless function bundle
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/jieba-wasm/pkg/nodejs/*.wasm"],
  },
};

export default nextConfig;

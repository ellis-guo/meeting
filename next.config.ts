import type { NextConfig } from "next";

// CSP: Clerk requires 'unsafe-inline' for styles and connects to clerk.com endpoints.
// DashScope calls are server-side only, so no connect-src entry needed here.
const csp = [
  "default-src 'self'",
  // Next.js inline scripts + Clerk JS (includes production custom domain)
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.com https://*.clerk.accounts.dev https://*.ellisguo.com https://challenges.cloudflare.com",
  // Clerk injects inline styles
  "style-src 'self' 'unsafe-inline'",
  // Fonts loaded from Google Fonts via next/font
  "font-src 'self' data: https://fonts.gstatic.com",
  // Images: self + data URIs (avatars, icons)
  "img-src 'self' data: blob: https:",
  // Clerk creates Web Workers from blob URLs for auth
  "worker-src 'self' blob:",
  // XHR/fetch: self + Clerk auth endpoints (includes production custom domain)
  "connect-src 'self' https://clerk.com https://*.clerk.accounts.dev https://api.clerk.com https://*.ellisguo.com https://challenges.cloudflare.com",
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
  // jieba-wasm 不打包，让 Node 能正确解析 __dirname；
  // unpdf / mammoth 同理：它们内部有动态 require 和自带的二进制/字体资源，
  // 被打包器改写路径后会在运行时找不到文件。
  serverExternalPackages: ["jieba-wasm", "unpdf", "mammoth"],
  // Include jieba-wasm WASM binary in Vercel serverless function bundle
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/jieba-wasm/pkg/nodejs/*.wasm"],
  },
  experimental: {
    // ⚠️ 本项目有 proxy.ts，Next 会把请求体缓冲进内存以便多次读取，**默认上限
    // 10MB，超过不报错也不失败**——路由只拿到前 10MB，然后在解析阶段炸成一个
    // 跟大小毫无关系的错误。参考文件上传是唯一会传大 body 的路径，所以显式配一个
    // 比单文件上限（documentParser.MAX_FILE_BYTES = 10MB）宽裕的值，把 multipart
    // 的分隔符和多文件一次传的余量算进去。
    proxyClientMaxBodySize: "24mb",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

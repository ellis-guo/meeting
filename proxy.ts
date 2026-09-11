import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// /api/internal/* 由 cron 等机器调用，没有 Clerk session，走不了这里的鉴权。
// 放行不等于开放：那些路由自己用共享密钥把关，且密钥缺失时返回 503 而不是放行。
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/internal/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;

  const { userId, redirectToSignIn } = await auth();
  if (!userId) return redirectToSignIn();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { ApiKeyProvider } from "@/lib/ApiKeyContext";
import ApiKeyModal from "./components/ApiKeyModal";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "会议总结",
  description: "AI 驱动的会议总结工具",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider afterSignOutUrl="/sign-in">
      <html
        lang="en"
        className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <ApiKeyProvider>
            <ApiKeyModal />
            {children}
            <Toaster richColors position="bottom-right" />
          </ApiKeyProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}

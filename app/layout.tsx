import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/core/layout/AppShell";

// The service-status banner and the paused-tool gate are resolved at render
// time. Re-rendering at most once a minute lets a scheduled `since` or an
// expired `until` (core/status/service-config.ts) take effect without a deploy.
export const revalidate = 60;

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: "RevyHubX",
  description: "Open-source developer utilities for Stellar testnet workflows.",
  icons: {
    icon: "/devtool-profile.png",
    apple: "/devtool-profile.png"
  },
  openGraph: {
    title: "RevyHubX",
    description: "Open-source developer utilities for Stellar testnet workflows.",
    images: ["/devtool-profile.png"]
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

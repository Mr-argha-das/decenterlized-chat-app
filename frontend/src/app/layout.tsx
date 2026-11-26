import type { Metadata } from "next";
import "./globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME || "RelayChat";

export const metadata: Metadata = {
  title: `${appName} Web — Federated End-to-End Encrypted Chat`,
  description:
    "Decentralized, federated end-to-end encrypted messaging web app powered by Web Crypto ECDH P-256 + AES-GCM.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}

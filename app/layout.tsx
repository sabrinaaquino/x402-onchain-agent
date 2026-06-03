import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Venice On-Chain Agent",
  description:
    "A chat-first on-chain agent: live Crypto RPC tools + web search, or a private E2EE model. Inference paid via x402.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

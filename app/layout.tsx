import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EdgeForge Sports | Combo Research",
  description: "Probability-first research for sports prediction markets across games, sports, and dates.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

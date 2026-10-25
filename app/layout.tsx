import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Water Boards Assistant (student prototype)",
  description:
    "A mockup of the California Water Boards website with a chat assistant that answers only from Tier 1 Water Board pages. Prototype built by UC Berkeley students. Not official Water Board guidance.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "Water Boards Assistant (student prototype)",
  description:
    "A mockup of the California Water Boards website with a chat assistant that answers only from saved Water Board pages. Prototype built by UC Berkeley students. Not official Water Board guidance.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#062033" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

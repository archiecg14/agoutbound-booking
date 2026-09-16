import type { Metadata, Viewport } from "next";
import { Archivo, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";
import "./theme.css";

// next/font self-hosts and inlines the font CSS, so there is no render-blocking request to
// fonts.googleapis.com and no flash of fallback type. On a phone opening a cold email that
// is the difference between the page feeling instant and feeling broken.
const archivo = Archivo({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const schibsted = Schibsted_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Book a call",
  description: "Choose a time.",
  // A booking link is a private URL sent to one person. It should never be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Deliberately NOT maximumScale: 1. Blocking zoom on a page where someone is reading a
  // date and a time is an accessibility failure, and it buys nothing.
  themeColor: "#07080A",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={`${archivo.variable} ${schibsted.variable} h-full`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

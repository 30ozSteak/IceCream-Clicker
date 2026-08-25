import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  "Clear FatBoy boxes, unlock the 12-pack, master nine reload challenges, and climb the global leaderboard.";

function metadataOrigin(requestHeaders: Headers): URL {
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0];
  const host = forwardedHost ?? requestHeaders.get("host");
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.toLowerCase();
  const localHost = host?.startsWith("localhost") || host?.startsWith("127.0.0.1");
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : localHost
        ? "http"
        : "https";

  try {
    return new URL(`${protocol}://${host ?? "fatboy-feed-frenzy.sites.openai.com"}`);
  } catch {
    return new URL("https://fatboy-feed-frenzy.sites.openai.com");
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const origin = metadataOrigin(await headers());
  const socialImage = new URL("/og-v2.png", origin).toString();

  return {
    metadataBase: origin,
    title: "FatBoy Clicker",
    description,
    alternates: { canonical: "/" },
    icons: {
      icon: "/brand/fatboy-logo.png",
      shortcut: "/brand/fatboy-logo.png",
    },
    openGraph: {
      type: "website",
      title: "FatBoy Clicker",
      description,
      siteName: "FatBoy Clicker",
      images: [
        {
          url: socialImage,
          width: 1200,
          height: 630,
          alt: "FatBoy Clicker — open, toss, unlock",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "FatBoy Clicker",
      description,
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b2f63",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

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
  "Tap to feed the crowd ice cream sandwiches, hire helpers to keep feeding while you rest, and climb the global leaderboard.";

function fallbackOrigin(): URL {
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return vercelHost
    ? new URL(`https://${vercelHost}`)
    : new URL("http://localhost:3000");
}

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
    return host ? new URL(`${protocol}://${host}`) : fallbackOrigin();
  } catch {
    return fallbackOrigin();
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const origin = metadataOrigin(await headers());

  return {
    metadataBase: origin,
    title: "Ice Cream Clicker",
    description,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      title: "Ice Cream Clicker",
      description,
      siteName: "Ice Cream Clicker",
    },
    twitter: {
      card: "summary",
      title: "Ice Cream Clicker",
      description,
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

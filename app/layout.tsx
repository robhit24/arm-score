import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  // Required so /api/og resolves to https://armiq.ai/api/og when social
  // platforms (Facebook, Twitter, iMessage, Slack) scrape the page. Without
  // it Next falls back to localhost:3000 during build and warns loudly.
  metadataBase: new URL("https://armiq.ai"),
  title: "ArmIQ AI — Free Pitch Score + Custom Training Plan",
  description:
    "Upload a pitching video, get a free score with your top 3 velocity-killing mistakes, and receive a custom pitching program delivered in minutes.",
  openGraph: {
    title: "ArmIQ AI — Free Pitch Score",
    description:
      "Upload a pitching video, get a free score with your top 3 fixes, and a custom training plan in minutes.",
    type: "website",
    images: [{ url: "/api/og", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ArmIQ AI — Free Pitch Score",
    description:
      "Upload a pitching video, get a free score with your top 3 fixes, and a custom training plan in minutes.",
    images: ["/api/og"],
  },
};

const META_PIXEL_ID = "1812432239715347";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <noscript>
          <img
            height="1"
            width="1"
            style={{ display: "none" }}
            src={`https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1`}
            alt=""
          />
        </noscript>
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${inter.variable}`}>
        {children}
        <Script id="meta-pixel" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${META_PIXEL_ID}');
            fbq('track', 'PageView');
          `}
        </Script>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";

// Rendered for every request, because each response carries its own Content-Security-Policy nonce (see proxy.ts).
export const dynamic = "force-dynamic";

// Everything behind the sign-in is private, so no page is indexed.
export const metadata: Metadata = {
  title: { default: "Manufacturing Tracker · Meridian Medical", template: "%s · Manufacturing Tracker" },
  description: "Demo manufacturing process tracking for 3D-printed medical devices",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}

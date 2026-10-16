import type { Metadata } from "next";

export const metadata: Metadata = { title: "Quality control" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

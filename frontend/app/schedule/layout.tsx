import type { Metadata } from "next";

export const metadata: Metadata = { title: "Printer schedule" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

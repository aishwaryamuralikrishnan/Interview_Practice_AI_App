import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

import { PAGE_TITLE } from "@/lib/config";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: "Practise a job interview built from a real posting, and get scored feedback on every answer.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

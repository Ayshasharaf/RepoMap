import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Syne } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const display = Syne({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-display-face" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono-face" });

export const metadata: Metadata = {
  title: "RepoMap",
  description: "Spring Boot scanner",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${display.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}

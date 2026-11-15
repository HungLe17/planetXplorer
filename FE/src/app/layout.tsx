import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "planetXplorer",
  description:
    "Inspect the infrared sky through time. A public SPHEREx observation explorer.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

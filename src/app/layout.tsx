import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Playfair_Display } from "next/font/google";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin"] });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Madaket Gen Studio",
  description: "Internal image and video generation for Madaket Brands.",
  icons: { icon: "/madaket-dog-sketch.png" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${playfair.variable} ${inter.variable} ${jetbrains.variable} h-full`}>
      <body className="min-h-full bg-navy text-cream">
        {children}
        <Toaster />
      </body>
    </html>
  );
}

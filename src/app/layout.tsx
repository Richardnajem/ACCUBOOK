import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import { UndoRedoProvider } from "@/lib/undo-redo";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stockfolio — Portfolio Manager by Richard Najem",
  description: "Track holdings, record trades, watchlist, backtesting, and technical analysis — all local",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('stockfolio-theme');
                var valid = ['dark','light','midnight','ocean','forest','sunset'];
                document.documentElement.classList.add(valid.indexOf(t) !== -1 ? t : 'dark');
              } catch(e) { document.documentElement.classList.add('dark'); }
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground transition-colors">
        <ThemeProvider><UndoRedoProvider>{children}</UndoRedoProvider></ThemeProvider>
      </body>
    </html>
  );
}

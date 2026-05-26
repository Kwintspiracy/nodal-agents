import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Self-hosted via next/font — no external CDN, no FOUT. Exposes the fonts as
// CSS variables so globals.css can fall them into --font-sans / --font-mono.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Nodal-Agents',
  description: 'Multi-agent platform',
};

// Inline theme bootstrap. Reads localStorage and applies data-theme BEFORE
// first paint to avoid a flash from the default theme. Mirrors the design
// bundle's Nodal.html bootstrap (key: nodal.theme). Light is the canonical
// default per the handoff intent.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('nodal.theme');if(t!=='dark'&&t!=='light')t='light';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

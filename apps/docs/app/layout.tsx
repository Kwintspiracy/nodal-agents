import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import {
  Archivo,
  IBM_Plex_Mono,
  Instrument_Sans,
  Inter,
  JetBrains_Mono,
  Public_Sans,
} from 'next/font/google';
import 'fumadocs-ui/style.css';
import './global.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jbmono' });

// Homepage typefaces. Declared here because `next/font` has to be called at
// module scope of a file that owns an element the variables can hang on, and
// only the <html> tag qualifies. The docs pages keep Inter for body text: these
// two variables are referenced solely by `app/home.css`.
const archivo = Archivo({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-archivo' });
const publicSans = Public_Sans({ subsets: ['latin'], variable: '--font-publicsans' });

// The hero, and the hero alone. The redesign names these two by name rather
// than as placeholders, so they are loaded rather than mapped onto the two
// above; `app/home.css` references them under `.home-hero-band` only, which
// keeps the rest of the page and every docs page on Public Sans and Inter.
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-instrument',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plexmono',
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${archivo.variable} ${publicSans.variable} ${instrumentSans.variable} ${plexMono.variable}`}
    >
      <body>
        <RootProvider
          search={{
            options: {
              type: 'static',
              api: '/nodal-agents/static.json',
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}

import type { ReactNode } from 'react';
import type { Metadata } from 'next';
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

/**
 * L'aperçu d'un lien partagé (Open Graph, et la carte large de X) : sans ces
 * balises, un lien vers le site ne montrait qu'un titre, aucune image.
 *
 * `metadataBase` est l'hôte GitHub Pages du dépôt, où `docs.yml` publie ; les
 * réseaux exigent une URL ABSOLUE. Le chemin de l'image porte `/nodal-agents`
 * parce que le site vit sous ce préfixe (`basePath` dans next.config.mjs) et
 * que Next ne l'ajoute pas aux URL de métadonnées.
 *
 * L'image est un JPG de 1200 × 630 (126 Ko) : certains aperçus ignorent les
 * images trop lourdes, et le WebP est mal lu par d'autres. Les pages en
 * héritent — aucune ne déclare son propre `openGraph`.
 */
export const metadata: Metadata = {
  metadataBase: new URL('https://kwintspiracy.github.io'),
  openGraph: {
    type: 'website',
    siteName: 'Nodal-Agents',
    images: [
      {
        url: '/nodal-agents/og.jpg',
        width: 1200,
        height: 630,
        alt: 'Nodal-Agents: herd your agents. Self-hosted AI agents on your own machine.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/nodal-agents/og.jpg'],
  },
};

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

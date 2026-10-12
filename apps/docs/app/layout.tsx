import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import 'fumadocs-ui/style.css';
import './fonts/fonts.css';
import './global.css';

// Fonts are self-hosted: `app/fonts/fonts.css` declares the @font-face rules
// over woff2 files committed in the repo and defines the six variables the
// stylesheets use (--font-inter, --font-jbmono, --font-archivo,
// --font-publicsans, --font-instrument, --font-plexmono) on :root. Nothing is
// fetched from a font CDN at build time (#688). The hero typefaces
// (Instrument Sans, IBM Plex Mono) are referenced solely by `app/home.css`,
// under `.home-hero-band`, which keeps every docs page on Inter.

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
    <html lang="en" suppressHydrationWarning>
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

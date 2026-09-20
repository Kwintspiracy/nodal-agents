import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { LOGO_SRC, PRODUCT_NAME } from '@/components/ui/BrandMark';

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
  title: PRODUCT_NAME,
  description: 'Multi-agent platform',
  // L'ONGLET PORTE LA MARQUE (#308). Le produit n'avait aucune icone : le
  // navigateur affichait la page blanche par defaut, et un onglet sans dessin
  // ne se retrouve pas dans une rangee de vingt.
  //
  // Le MEME fichier que le rail, pointe depuis `public/`, plutot qu'un
  // `app/icon.png` que Next servirait a son propre chemin : la convention de
  // fichier aurait demande une SECONDE copie du meme dessin dans le depot, et
  // deux copies d'une image finissent par diverger.
  icons: { icon: LOGO_SRC },
  // Safari iOS transforme tout nombre qui ressemble à un téléphone en lien
  // `tel:` et COUPE le nœud de texte autour — l'argument `"seed": 8472910452`
  // d'une carte d'approbation faisait échouer l'hydratation sur l'iPad
  // (Quentin, 20/09). Le produit n'affiche jamais un numéro à composer.
  formatDetection: { telephone: false, email: false, address: false },
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

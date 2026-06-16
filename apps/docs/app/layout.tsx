import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import 'fumadocs-ui/style.css';
import './global.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jbmono' });

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
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

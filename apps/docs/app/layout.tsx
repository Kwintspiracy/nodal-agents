import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import 'fumadocs-ui/style.css';

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

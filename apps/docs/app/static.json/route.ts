import { source } from '@/lib/source';
import { createSearchAPI } from 'fumadocs-core/search/server';

// `staticGET`, pas `GET`. Le client (app/layout.tsx) est en `type: 'static'` :
// il telecharge l index entier et cherche localement, donc le serveur n a qu a
// servir cet index — `staticGET` ne prend aucune requete. `GET`, lui, lit
// `request.url` pour recuperer `?query=`, ce qui est incompatible avec
// `force-static`. Next 16.2 ne le sanctionnait pas ; 16.3 a durci l analyse
// statique et fait echouer le build. Le mauvais handler etait exporte depuis le
// debut — la montee de version l a revele, elle ne l a pas cause.
export const { staticGET: GET } = createSearchAPI('simple', {
  indexes: source.getPages().map((page) => ({
    title: page.data.title,
    description: page.data.description ?? '',
    url: page.url,
    id: page.url,
    content: '',
  })),
});

export const dynamic = 'force-static';

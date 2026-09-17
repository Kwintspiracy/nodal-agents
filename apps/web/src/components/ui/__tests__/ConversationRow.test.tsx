// ConversationRow.test.tsx — la ligne de la boîte de réception, DESSINÉE (#135).
//
// Le module pur dit ce qu'une ligne doit porter ; ce fichier dit qu'elle le
// porte vraiment. Ce qu'il tient, et que le test pur ne peut pas tenir : le
// lien est bien un lien, l'avatar montre la vraie image quand il y en a une,
// UN SEUL signe est dessiné, et une ligne au repos n'en dessine aucun.
//
// Mutations vérifiées : le point vert rendu en même temps que la pastille
// → le test « un seul signe » rougit ; la pastille rendue au repos → le test
// « rien au repos » rougit ; `Approval pending` rendu pour une question → le
// test de priorité rougit.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationRow from '../ConversationRow.tsx';

const BASE = {
  id: 'conv-1',
  rowKey: 'agent-1:telegram:42',
  href: '/chat/conv-1',
  agentName: 'Marlow',
  agentAvatarUrl: null,
  chatName: 'Mireille',
  preview: 'C’est envoyé.',
  time: '14:02',
  waiting: null,
  running: false,
} as const;

function render(over: Partial<React.ComponentProps<typeof ConversationRow>> = {}): string {
  return renderToStaticMarkup(<ConversationRow {...BASE} {...over} />);
}

/** Le texte seul, balises retirées — pour chercher un libellé sans son balisage. */
function texte(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

describe('la ligne d’une conversation @cap:reprendre-conversation/ecran', () => {
  it('mène au fil, et porte son identifiant pour qu’on la retrouve', () => {
    const html = render();
    expect(html).toContain('href="/chat/conv-1"');
    expect(html).toContain('data-testid="conversation-row-conv-1"');
  });

  it('dit l’agent, le nom du chat et le dernier mot', () => {
    const t = texte(render());
    expect(t).toContain('Marlow');
    expect(t).toContain('Mireille');
    expect(t).toContain('C’est envoyé.');
    expect(t).toContain('14:02');
  });

  it('montre la VRAIE image de l’agent quand il en a une', () => {
    const html = render({ agentAvatarUrl: '/avatars/marlow.png' });
    expect(html).toContain('img');
    expect(html).toContain(encodeURIComponent('/avatars/marlow.png'));
  });

  it('sans aperçu, aucune seconde ligne — et sans heure, aucune heure', () => {
    const t = texte(render({ preview: null, time: null }));
    expect(t).not.toContain('C’est envoyé.');
    expect(t).not.toContain('14:02');
    // Et surtout pas de tiret à leur place : un vide se lit, un tiret se
    // prendrait pour une valeur (invariant #4).
    expect(t).not.toContain('—:—');
  });

  it('une question demandée s’écrit, et rien d’autre ne s’allume', () => {
    const html = render({ waiting: 'question', running: true });
    expect(texte(html)).toContain('Question asked');
    expect(texte(html)).not.toContain('Approval pending');
    // Le point vert du run n'est PAS dessiné en plus : deux signes côte à côte
    // ne se lisent plus. `bg-ok` est la classe du point ; celui de la pastille
    // `run` est bleu (`bg-conn-vivid`).
    expect(html).not.toContain('bg-ok ');
  });

  it('une approbation en attente s’écrit sur fond d’alerte', () => {
    const html = render({ waiting: 'approval' });
    expect(texte(html)).toContain('Approval pending');
    expect(texte(html)).not.toContain('Question asked');
    expect(html).toContain('bg-warn-bg');
  });

  it('un run qui tourne : un POINT, jamais un nombre', () => {
    const html = render({ running: true });
    expect(html).toContain('bg-ok ');
    // 8 px — la taille `md` de la planche.
    expect(html).toContain('h-2 w-2');
    expect(texte(html)).not.toContain('Question asked');
    expect(texte(html)).not.toContain('Approval pending');
    expect(texte(html)).not.toMatch(/\b1 run\b/);
  });

  it('au repos, la ligne ne porte AUCUN signe', () => {
    const html = render();
    expect(texte(html)).not.toContain('Question asked');
    expect(texte(html)).not.toContain('Approval pending');
    expect(html).not.toContain('bg-ok ');
  });

  it('sans fil désigné, pas de lien — et la ligne le DIT', () => {
    const html = render({ id: null, href: null });
    expect(html).not.toContain('<a ');
    expect(texte(html)).toContain('unavailable');
    expect(texte(html)).toContain('Mireille');
    // Elle garde une identité PROPRE : deux chats sans fil désigné ne peuvent
    // pas partager le même repère à l'écran.
    expect(html).toContain('data-testid="conversation-row-agent-1:telegram:42"');
  });

  it('la géométrie de la planche : 56 px, gouttière 14, marges 0/16', () => {
    const html = render();
    expect(html).toContain('h-14');
    expect(html).toContain('gap-3.5');
    expect(html).toContain('px-4');
  });
});

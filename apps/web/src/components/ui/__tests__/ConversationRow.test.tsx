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
// test de priorité rougit ; l'avatar et le nom rendus MÊME sans agent → les
// tests de la ligne sans agent rougissent (18/09).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationRow from '../ConversationRow.tsx';

const BASE = {
  id: 'conv-1',
  rowKey: 'agent-1:telegram:42',
  href: '/chat/conv-1',
  agent: { name: 'Marlow', avatarUrl: null },
  chatName: 'Mireille',
  preview: 'C’est envoyé.',
  time: '14:02',
  waiting: null,
  running: false,
  unread: false,
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
    const html = render({ agent: { name: 'Marlow', avatarUrl: '/avatars/marlow.png' } });
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

// ─── Non lu (#209, 19/09/2026) ───────────────────────────────────────────────

describe('une ligne NON LUE @cap:reprendre-conversation/ecran', () => {
  // Mutation vérifiée : le poids rendu SANS regarder `unread` (toujours
  // `text-medium-14`) → les deux premiers tests rougissent.

  it('écrit son titre plus gras que celui d’une ligne lue, à la même taille', () => {
    const nonLu = render({ agent: null, chatName: 'Recettes du dimanche', unread: true });
    const lu = render({ agent: null, chatName: 'Recettes du dimanche', unread: false });

    expect(nonLu).toContain('text-medium-14');
    expect(lu).toContain('text-body-14');
    expect(lu).not.toContain('text-medium-14');
    // MÊME taille et même interlignage des deux côtés — ce sont les deux
    // jetons 14 px du design system. Un titre qui changerait de taille ferait
    // sauter la ligne au moment où on la lit.
    expect(nonLu).not.toContain('text-medium-15');
    expect(nonLu).not.toContain('text-title-16');
  });

  it('porte le poids sur le NOM DE L’AGENT quand la ligne en montre un', () => {
    // Sur un dossier de canal, la ligne principale est l'agent ; c'est elle qui
    // doit s'alourdir, pas l'étiquette du chat qui la suit.
    const html = render({ unread: true });
    const principale = html.slice(html.indexOf('Marlow') - 120, html.indexOf('Marlow'));
    expect(principale).toContain('text-medium-14');
  });

  it('ne dessine AUCUN mot « Unread », ni pastille de plus', () => {
    // La planche en dessinait une. Le propriétaire a tranché autrement
    // (19/09) : un quatrième signe à droite entrerait en concurrence avec les
    // trois qui disent ce que le fil ATTEND.
    const html = render({ unread: true });
    expect(texte(html).toLowerCase()).not.toContain('unread');
    // Et rien ne s'est ajouté à droite : au repos, la ligne ne porte toujours
    // ni pastille ni point.
    expect(texte(html)).not.toContain('Question asked');
    expect(texte(html)).not.toContain('Approval pending');
    expect(html).not.toContain('bg-ok ');
  });

  it('laisse les trois signes dire ce qu’ils disent, non lue ou non', () => {
    // Le poids du titre et la pastille sont deux langues différentes : l'une
    // dit « tu n'as pas vu », l'autre « on t'attend ». Elles coexistent.
    const html = render({ unread: true, waiting: 'question' });
    expect(texte(html)).toContain('Question asked');
    expect(html).toContain('text-medium-14');
  });
});

describe('la ligne SANS agent : le dossier « Nodal chats » @cap:reprendre-conversation/ecran', () => {
  // Quentin, 18/09 : « pas besoin de répéter l'agent partout avec son avatar ;
  // pas besoin de montrer le dernier message posté ; il faut juste un titre de
  // conversation ». Ces lignes-là sont toutes du même agent.
  const SANS_AGENT = { agent: null, chatName: 'Recettes du dimanche', preview: null } as const;

  it('ni avatar ni nom d’agent — le titre est la ligne', () => {
    const html = render(SANS_AGENT);
    const t = texte(html);
    expect(t).toContain('Recettes du dimanche');
    expect(t).not.toContain('Marlow');
    // L'avatar dessine soit une image, soit les initiales dans un carré : ni
    // l'un ni l'autre ne doit rester.
    expect(html).not.toContain('<img');
    expect(t).not.toContain('MA');
    // Et surtout pas le tiret de l'agent sans nom : il n'y a pas d'agent du
    // tout, ce n'est pas un nom illisible.
    expect(t).not.toContain('—');
  });

  it('le titre porte la graisse et la couleur de la ligne principale', () => {
    // NON LU (#209) : le poids fort, celui qu'avaient toutes les lignes avant
    // que l'état de lecture existe.
    const html = render({ ...SANS_AGENT, unread: true });
    expect(html).toContain('truncate text-medium-14 text-ink');
    // Pas d'étiquette mono : elle ne s'étire pas, et coupait le titre à 18
    // signes au milieu de la ligne.
    expect(html).not.toContain('font-mono');
  });

  it('le signe de ce qui s’y passe ne bouge pas, lui', () => {
    expect(texte(render({ ...SANS_AGENT, waiting: 'approval' }))).toContain('Approval pending');
    expect(render({ ...SANS_AGENT, running: true })).toContain('bg-ok ');
    // L'heure non plus.
    expect(texte(render(SANS_AGENT))).toContain('14:02');
  });

  it('sans fil désigné, elle le dit aussi', () => {
    const html = render({ ...SANS_AGENT, id: null, href: null });
    expect(html).not.toContain('<a ');
    expect(texte(html)).toContain('unavailable');
    expect(texte(html)).toContain('Recettes du dimanche');
  });
});

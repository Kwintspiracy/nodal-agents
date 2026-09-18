// job-lineage.test.ts — remonter une chaîne de délégation jusqu'à sa tête.
//
// Ce que ça prouve : un délégué qui ne dit rien de sa provenance en retrouve
// une par son parent, et une chaîne qu'on ne peut pas remonter ENTIÈREMENT ne
// rend rien plutôt qu'une supposition (invariant #4).
//
// Les assertions portent sur la tête rendue — son identifiant et son canal —
// jamais sur des appels comptés.
//
// Mutation vérifiée : dans `rootOf`, le `return INTROUVABLE` du parent absent
// remplacé par le maillon courant → « ne devine pas une tête » rougit ; le
// plafond retiré → « ne tourne pas en rond » ne termine plus.

import { describe, it, expect } from 'vitest';
import { rootOf, MAX_LINEAGE_HOPS, type JobLineageRow } from '../job-lineage.ts';

function carte(...rows: JobLineageRow[]): Map<string, JobLineageRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

describe('la tête d’une chaîne de délégation @cap:parler-par-canal-externe/moteur', () => {
  it('rend le job lui-même quand personne ne l’a délégué', () => {
    const byId = carte({ id: 'a', channel: 'mcp', parentJobId: null });
    expect(rootOf('a', byId)).toEqual({ rootJobId: 'a', rootChannel: 'mcp' });
  });

  it('remonte un délégué jusqu’au canal de son run de tête', () => {
    // Le cas réel : un run `api` délègue, l'enfant porte `internal` et aucune
    // conversation. Sans la remontée, il ne vient de nulle part.
    const byId = carte(
      { id: 'racine', channel: 'api', parentJobId: null },
      { id: 'enfant', channel: 'internal', parentJobId: 'racine' },
    );
    expect(rootOf('enfant', byId)).toEqual({ rootJobId: 'racine', rootChannel: 'api' });
  });

  it('remonte plusieurs niveaux, jusqu’au plafond de délégation du produit', () => {
    const byId = carte(
      { id: 'r', channel: 'mcp', parentJobId: null },
      { id: 'n1', channel: 'internal', parentJobId: 'r' },
      { id: 'n2', channel: 'internal', parentJobId: 'n1' },
      { id: 'n3', channel: 'task-board', parentJobId: 'n2' },
    );
    expect(rootOf('n3', byId).rootChannel).toBe('mcp');
    expect(rootOf('n3', byId).rootJobId).toBe('r');
  });

  it('ne devine pas une tête quand un maillon manque', () => {
    // Le parent n'a pas été lu — supprimé, ou hors entité. Rendre `internal`
    // ferait passer « je ne sais pas » pour « ça vient d'un agent ».
    const byId = carte({ id: 'enfant', channel: 'internal', parentJobId: 'disparu' });
    expect(rootOf('enfant', byId)).toEqual({ rootJobId: null, rootChannel: null });
  });

  it('ne rend rien pour un job absent de la lecture', () => {
    expect(rootOf('inconnu', carte())).toEqual({ rootJobId: null, rootChannel: null });
  });

  it('ne tourne pas en rond sur une chaîne qui se mord la queue', () => {
    const byId = carte(
      { id: 'a', channel: 'internal', parentJobId: 'b' },
      { id: 'b', channel: 'internal', parentJobId: 'a' },
    );
    expect(rootOf('a', byId)).toEqual({ rootJobId: null, rootChannel: null });
  });

  it('s’arrête au plafond plutôt que de remonter indéfiniment', () => {
    // Une chaîne plus longue que tout ce que le produit autorise (invariant #8,
    // trois niveaux) : on rend « inconnu », pas le maillon atteint au plafond.
    const rows: JobLineageRow[] = [];
    const longueur = MAX_LINEAGE_HOPS + 3;
    for (let i = 0; i < longueur; i += 1) {
      rows.push({
        id: `j${i}`,
        channel: i === longueur - 1 ? 'mcp' : 'internal',
        parentJobId: i === longueur - 1 ? null : `j${i + 1}`,
      });
    }
    expect(rootOf('j0', carte(...rows))).toEqual({ rootJobId: null, rootChannel: null });
  });
});

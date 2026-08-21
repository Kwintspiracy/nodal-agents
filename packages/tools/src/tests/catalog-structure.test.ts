// catalog-structure.test.ts — lot 3 du plan des tests manquants.
//
// Les skills du catalogue sont des DONNÉES, pas du code : d'où l'absence de
// tests jusqu'ici. Mais elles partent chez TOUS les agents de TOUTES les
// installations, et une faute y voyage sans bruit — c'est là qu'on a trouvé
// `"agentSlug": "displacer"`, le nom d'un agent personnel, dans un exemple
// livré à tout le monde.
//
// D'où la forme : un test STRUCTUREL sur le lot entier, pas vingt tests. Chaque
// règle ci-dessous est une faute qu'on a déjà commise ou qu'on peut commettre
// en éditant une skill, et qu'aucune relecture n'attrape de façon fiable.
//
// Ce que ce fichier NE fait pas : vérifier que le CONTENU est bon. Une skill
// peut passer toutes ces règles et donner une consigne stupide. Ce qui est
// couvert ici, c'est ce qui se mesure — les références qui doivent exister, les
// valeurs qui ne doivent jamais fuiter, la syntaxe qui doit parser.

// Ce fichier vit dans `packages/tools` et non dans `packages/catalog` : il a
// besoin du registre d'outils pour vérifier que les `requiredBuiltins`
// existent, et c'est `tools` qui dépend de `catalog`, jamais l'inverse. Le
// mettre côté catalogue créerait un cycle que dependency-cruiser refuse.

import { describe, it, expect } from 'vitest';
import { systemSkills, systemSkillSlugs, skillKind } from '@nodal-agents/catalog';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin/index';

/** Les noms d'outils réellement enregistrés par le produit. */
const registry = createToolRegistry();
registerBuiltins(registry);
const builtinNames = new Set(registry.list().map((t) => t.name));

const KINDS = ['baseline', 'channel', 'capability', 'agent-internal'] as const;

describe('catalogue de skills — forme de chaque entrée', () => {
  it('slug, nom, description et contenu sont tous renseignés', () => {
    for (const s of systemSkills) {
      expect(s.slug, 'un slug vide casse l’assignation et le nommage d’outil').toMatch(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
      );
      expect(s.name.trim().length, `${s.slug}: nom vide`).toBeGreaterThan(0);
      expect(s.description.trim().length, `${s.slug}: description vide`).toBeGreaterThan(0);
      expect(s.content.trim().length, `${s.slug}: contenu vide`).toBeGreaterThan(0);
    }
  });

  it('les slugs sont uniques — un doublon ferait taire silencieusement une skill', () => {
    const seen = new Map<string, number>();
    for (const slug of systemSkillSlugs) seen.set(slug, (seen.get(slug) ?? 0) + 1);
    const doublons = [...seen.entries()].filter(([, n]) => n > 1).map(([slug]) => slug);
    expect(doublons, 'slugs en double dans le catalogue').toEqual([]);
  });

  it('chaque skill a un kind connu', () => {
    for (const s of systemSkills) {
      expect(KINDS, `${s.slug}: kind inattendu`).toContain(skillKind(s));
    }
  });
});

describe('catalogue de skills — références vers de vrais outils', () => {
  // Le cas qui motive ce test : une skill qui réclame un outil disparu ou mal
  // orthographié ne fait rien échouer. L'agent ne reçoit simplement jamais
  // l'outil, et la skill lui demande de s'en servir.
  it('chaque requiredBuiltins existe dans le registre des outils intégrés', () => {
    const inconnus: string[] = [];
    for (const s of systemSkills) {
      for (const tool of s.requiredBuiltins ?? []) {
        if (!builtinNames.has(tool)) inconnus.push(`${s.slug} → ${tool}`);
      }
    }
    expect(inconnus, 'des skills réclament des outils qui n’existent pas').toEqual([]);
  });

  it('aucune skill n’embarque un bloc de config MCP d’un autre client', () => {
    // `lintSkillContent` rejette ce motif à l'installation d'une skill
    // communautaire ; les skills qu'on livre nous-mêmes ne passent pas par ce
    // chemin, donc rien ne les en empêchait.
    for (const s of systemSkills) {
      expect(
        s.content,
        `${s.slug}: bloc "mcpServers" — appartient à Claude Desktop / Cursor`,
      ).not.toMatch(/"mcpServers"\s*:/);
    }
  });
});

describe('catalogue de skills — rien de personnel ne doit fuiter', () => {
  it('aucun UUID en dur (invariant #6)', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const s of systemSkills) {
      expect(s.content, `${s.slug}: UUID en dur — il ne vaut que sur une installation`).not.toMatch(
        uuid,
      );
    }
  });

  it('aucun chemin qui désigne une machine réelle', () => {
    // Ce qu'on cherche n'est pas « un chemin absolu » — la skill obsidian en
    // montre un exprès, comme CONTRE-exemple (« ❌ Absolute path (D:\…\foo.md)
    // — the workspace already scopes you »). Interdire la forme casserait une
    // consigne juste.
    //
    // Le risque réel, c'est un chemin qui nomme quelqu'un : un répertoire
    // utilisateur concret, ou l'arborescence du dépôt sur ma machine. Les
    // placeholders (`...`, `<vous>`, `you`, `username`) sont explicitement
    // tolérés — ils enseignent la forme sans désigner personne.
    const placeholder = /^(\.{3}|…|<[^>]*>|you|username|user|votre-nom)$/i;
    const repUtilisateur = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)([^\\/\s`'")]+)/g;
    const arboDepot = /APPS[\\/]NodalAI/i;

    for (const s of systemSkills) {
      expect(s.content, `${s.slug}: cite l’arborescence du dépôt d’un poste précis`).not.toMatch(
        arboDepot,
      );
      const nommes = [...s.content.matchAll(repUtilisateur)]
        .map((m) => m[1] ?? '')
        .filter((nom) => !placeholder.test(nom));
      expect(nommes, `${s.slug}: nomme un répertoire utilisateur réel`).toEqual([]);
    }
  });

  it('aucun slug d’agent personnel dans les exemples', () => {
    // Le précédent exact : "agentSlug": "displacer" livré à tout le monde. Un
    // agent n'est JAMAIS livré avec le produit (les agents sont tous créés par
    // l'utilisateur), donc un slug d'agent nommé dans une skill du catalogue
    // désigne forcément quelqu'un en particulier.
    const agentsPersonnels = /\b(displacer|alfred|sputnik|tatooine|comfyartist|promptmaster)\b/i;
    for (const s of systemSkills) {
      expect(s.content, `${s.slug}: nomme un agent personnel`).not.toMatch(agentsPersonnels);
    }
  });

  it('aucune chaîne en forme de credential', () => {
    // Assemblé à l'exécution : un littéral EN FORME de token dans ce fichier
    // serait refusé par la protection de poussée GitHub, vraie clé ou fausse.
    const formes = [
      ['sk', '-'].join('') + '[A-Za-z0-9]{20,}',
      ['xox', 'b-'].join('') + '[0-9]{6,}',
      ['AKIA', '[A-Z0-9]{16}'].join(''),
      ['gh', 'p_'].join('') + '[A-Za-z0-9]{30,}',
    ];
    const credential = new RegExp(formes.join('|'));
    for (const s of systemSkills) {
      expect(s.content, `${s.slug}: contient une chaîne en forme de credential`).not.toMatch(
        credential,
      );
    }
  });
});

describe('catalogue de skills — les blocs de code parsent', () => {
  it('chaque bloc ```json est du JSON valide', () => {
    const erreurs: string[] = [];
    for (const s of systemSkills) {
      const blocs = [...s.content.matchAll(/```json\s*\n([\s\S]*?)```/g)];
      for (const [i, bloc] of blocs.entries()) {
        const corps = (bloc[1] ?? '').trim();
        if (!corps) continue;
        // Les gabarits documentent des trous à remplir (<slug>, …) : ce ne sont
        // pas des exemples exécutables, on ne leur demande pas de parser.
        if (/[<>]|\.\.\.|…/.test(corps)) continue;
        try {
          JSON.parse(corps);
        } catch (err) {
          erreurs.push(`${s.slug} bloc #${i + 1}: ${(err as Error).message}`);
        }
      }
    }
    expect(erreurs, 'des blocs ```json ne parsent pas').toEqual([]);
  });
});

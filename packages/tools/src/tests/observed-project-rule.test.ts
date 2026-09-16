// observed-project-rule.test.ts — l'OBSERVATION nomme le même projet que
// l'intention, et ne peut plus l'oublier.
//
// Revue de la PR #103 (Reviewer C, passe 2), constat mineur 1. Le prédicat
// « cette racine EST un projet » était OPTIONNEL sur `observedDeliverableKeys`,
// avec un repli sur `hasMarker` seul. Un appelant qui l'omettait retrouvait en
// silence la règle d'avant le correctif du constat C4 : pour un projet DÉCLARÉ
// sans manifeste, l'intention salissait `app` pendant que l'observation créditait
// `app/src`, et le livrable restait `produced = false` sur un fichier bel et bien
// écrit. Aucune erreur, aucun log — un repli intelligent (invariant #4).
//
// Deux preuves, et il en faut deux : le compilateur refuse l'oubli
// (`@ts-expect-error` ci-dessous, qui devient lui-même une erreur le jour où le
// paramètre redevient optionnel), et le RÉSULTAT des deux règles est comparé sur
// le cas qui les séparait.

import { describe, it, expect } from 'vitest';
import { projectKey, resolveProjectRoots, type MutationTarget } from '@nodal-agents/shared';
import { observedDeliverableKeys } from '../verification/observed';
import { projectRootPredicate } from '../projects/declared';
import { rebaseOntoLexicalRoots } from '../projects/markers';

/** Un terrain qui n'existe pas sur le disque : aucun manifeste ne s'y lit. */
const TERRAIN = '/tmp/nodal-observed-rule/terrain';
const APP = `${TERRAIN}/app`;

const fichier = (path: string): MutationTarget => ({
  kind: 'file',
  path,
  deliverableType: 'code_project',
  scope: 'addressed',
});

describe('observedDeliverableKeys — la règle de projet de l’intention @cap:verifier-un-livrable/moteur', () => {
  it('un projet DÉCLARÉ sans manifeste : la clé constatée est celle que l’intention salit', () => {
    const cibles = [fichier(`${APP}/src/a.ts`)];
    // DEUX dossiers attachés qui s'emboîtent — la configuration du constat C4.
    // Sans le second, la règle « enfant direct du terrain » nomme `app` toute
    // seule et les deux prédicats tombent d'accord par accident.
    const workspaceRoots = [TERRAIN, APP];
    // Le prédicat que le seam d'exécution passe : `app` est déclarée en base,
    // et rien ne porte de manifeste sur ce terrain (il n'existe pas).
    const isProjectRoot = projectRootPredicate([APP]);

    const intention = resolveProjectRoots({
      targets: rebaseOntoLexicalRoots(cibles, workspaceRoots),
      workspaceRoots,
      hasMarker: isProjectRoot,
    }).map((p) => p.key);
    // La clé de l'intention est celle du projet DÉCLARÉ, pas de son sous-dossier.
    expect(intention).toEqual([projectKey(APP)]);

    const constate = observedDeliverableKeys({
      changedFiles: cibles,
      dirTargets: [],
      workspaceRoots,
      isProjectRoot,
    });

    // Les deux règles rendent LA MÊME clé — c'est tout l'enjeu de `produced`.
    expect([...constate]).toEqual(intention);

    // Et la preuve que ce cas sépare bien les deux règles : avec le manifeste
    // seul — l'ancien repli — la clé constatée est celle du sous-dossier.
    const avecManifesteSeul = observedDeliverableKeys({
      changedFiles: cibles,
      dirTargets: [],
      workspaceRoots,
      isProjectRoot: () => false,
    });
    expect([...avecManifesteSeul]).toEqual([projectKey(`${APP}/src`)]);
  });

  it('le prédicat ne peut plus être oublié — le compilateur refuse l’appel', () => {
    // La directive est posée sur la LIGNE de l'argument, pas sur celle de la
    // déclaration : TypeScript rapporte l'erreur à la position de l'objet, et
    // une directive posée plus haut ne couvre pas cette ligne — elle passerait
    // pour inutilisée tout en laissant l'erreur, donc rouge des deux côtés.
    const sansPredicat = () =>
      observedDeliverableKeys(
        // @ts-expect-error `isProjectRoot` est OBLIGATOIRE : cet appel ne
        // compile pas. Si le paramètre redevenait optionnel, cette directive
        // deviendrait elle-même une erreur (« unused '@ts-expect-error' ») et
        // `pnpm typecheck` rougirait — c'est ce qui rend la règle exécutoire.
        {
          changedFiles: [fichier(`${APP}/src/a.ts`)],
          dirTargets: [],
          workspaceRoots: [TERRAIN, APP],
        },
      );
    // L'appel n'est jamais exécuté : ce cas est une assertion de TYPE. On le
    // garde référencé pour que rien ne le déclare inutilisé.
    expect(typeof sansPredicat).toBe('function');
  });
});

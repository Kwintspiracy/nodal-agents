// alerte.mjs — un tableau qu'il faut penser à ouvrir n'existe pas.
//
// Le portail savait tout et ne disait rien : il fallait aller le regarder. Ce
// script fait le seul geste qui manquait — quand quelque chose est rouge, il
// ouvre une issue. Elle atterrit dans le Kanban, à sa colonne, comme n'importe
// quel autre travail. Pas de mail, pas de canal de plus.
//
// UNE issue, pas une par écart. Un robot qui ouvre douze tickets par nuit se
// fait couper au bout de trois jours ; celui-ci tient un seul billet à jour, et
// le ferme dès qu'il n'a plus rien à dire.
//
//   node apps/qa/alerte.mjs             → dit ce qu'il ferait, ne fait rien
//   node apps/qa/alerte.mjs --appliquer → ouvre, met à jour, ou ferme
//
// Le défaut est volontairement l'inaction : un script qui écrit sur GitHub dès
// qu'on le lance est un script qu'on n'ose plus lancer pour voir.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ecartsDe, alertes } from './lib.mjs';

const ICI = dirname(fileURLToPath(import.meta.url));
const DATA = join(ICI, 'data');
const RACINE = join(ICI, '..', '..');

export const TITRE = 'Portail : ce qui est rouge';

/**
 * Le corps de l'issue.
 *
 * Il nomme la collecte qui l'a produit — sans ça, personne ne peut dire si le
 * billet parle d'aujourd'hui ou d'il y a trois semaines, et un billet dont on
 * doute est un billet qu'on ignore.
 */
export function corpsDeLalerte(liste, meta = {}) {
  const entete = [
    `**${liste.length} chose(s) au rouge.** Ce billet est tenu à jour par la mesure nocturne ; il se ferme tout seul quand il n'a plus rien à dire.`,
    '',
    `Collecte du ${meta.le ?? '—'} · commit \`${meta.commit ?? '—'}\` · branche \`${meta.branche ?? '—'}\``,
    '',
  ];

  const corps = liste.map((e) => {
    const lignes = [`### ${e.titre}`, '', e.detail];
    if ((e.quoi ?? []).length > 0) {
      // Bornée : une liste de deux cents lignes ne se lit pas, et le billet
      // devient exactement le bruit qu'il devait remplacer.
      const montres = e.quoi.slice(0, 15);
      lignes.push('', ...montres.map((q) => `- \`${q}\``));
      if (e.quoi.length > montres.length) {
        lignes.push(`- … et ${e.quoi.length - montres.length} autres`);
      }
    }
    return lignes.join('\n');
  });

  return [...entete, ...corps].join('\n\n').trim();
}

/**
 * Le billet d'alerte parmi ceux que GitHub a rendus — au titre EXACT.
 *
 * Le titre exact et rien d'autre : la recherche GitHub est approximative et
 * rendrait aussi « Portail : ce qui est rouge — suite », qu'un humain aurait pu
 * ouvrir à côté. Éditer celui-là reviendrait à écraser le travail de quelqu'un.
 */
export function trouverLeBillet(liste, titre) {
  return (liste ?? []).find((i) => i.title === titre) ?? null;
}

const gh = (args) =>
  execFileSync('gh', args, { cwd: RACINE, encoding: 'utf8', maxBuffer: 32e6 }).trim();

/**
 * Le billet ouvert, cherché PAR SON TITRE côté serveur.
 *
 * La première version listait les cinquante issues ouvertes les plus récentes et
 * cherchait dedans. Passé ce seuil, le billet existant sortait du lot : une
 * mesure rouge en aurait ouvert un DEUXIÈME, et une mesure propre n'aurait
 * jamais pu fermer le premier — le portail se serait mis à empiler des doublons
 * exactement comme le robot qu'il ne veut pas être (revue Codex du 11/09).
 */
function issueOuverte() {
  const brut = gh([
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    `in:title "${TITRE}"`,
    '--limit',
    '50',
    '--json',
    'number,title',
  ]);
  return trouverLeBillet(JSON.parse(brut || '[]'), TITRE);
}

function main(appliquer) {
  const snapshot = JSON.parse(readFileSync(join(DATA, 'snapshot.json'), 'utf8'));
  const historique = existsSync(join(DATA, 'history.ndjson'))
    ? readFileSync(join(DATA, 'history.ndjson'), 'utf8').split('\n').filter(Boolean)
    : [];

  const liste = alertes(ecartsDe(snapshot, historique));
  const meta = { le: snapshot.genereLe, commit: snapshot.commit, branche: snapshot.branche };

  if (liste.length === 0) {
    console.log('Rien au rouge.');
    if (!appliquer) return 0;
    const ouverte = issueOuverte();
    if (!ouverte) {
      console.log('Aucun billet à fermer.');
      return 0;
    }
    gh(['issue', 'close', String(ouverte.number), '--comment', 'Plus rien au rouge.']);
    console.log(`Billet #${ouverte.number} fermé.`);
    return 0;
  }

  const corps = corpsDeLalerte(liste, meta);
  console.log(`${liste.length} chose(s) au rouge :`);
  for (const e of liste) console.log(`  · ${e.titre}`);

  if (!appliquer) {
    console.log('\n(rien écrit — relancer avec --appliquer)');
    return 0;
  }

  const ouverte = issueOuverte();
  if (ouverte) {
    gh(['issue', 'edit', String(ouverte.number), '--body', corps]);
    console.log(`Billet #${ouverte.number} mis à jour.`);
  } else {
    const url = gh(['issue', 'create', '--title', TITRE, '--body', corps, '--label', 'test']);
    console.log(`Billet ouvert : ${url}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.includes('--appliquer')));
}

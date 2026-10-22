// campaign/cli.ts — `pnpm bench:campaign`
//
//   pnpm bench:campaign                      une campagne : le jeu de nuit, un essai chacun, le modèle de la configuration
//   pnpm bench:campaign --only question,code --trials 3
//   pnpm bench:campaign --activity excel,word
//   pnpm bench:campaign --models openrouter:anthropic/claude-haiku-5.5,openrouter:z-ai/glm-5.3
//                                            la matrice : chaque scénario sur chaque modèle, dans la même instance
//   pnpm bench:campaign --models a,b --dry-run   le plan et son coût estimé, sans rien démarrer
//   pnpm bench:campaign --keys <fichier>     le fichier de clés (défaut ~/.nodal-bench/keys.json)
//   pnpm bench:campaign check                la configuration et le fichier de clés, validés ; l'empreinte
//   pnpm bench:campaign rehearsal            tout le cycle sans aucun essai : démarrer, appliquer, vérifier, effacer
//   pnpm bench:campaign erase                efface les campagnes qu'un banc mort a laissées
//
// Ce fichier n'importe que `home.ts` : il calcule le dossier de la campagne,
// y pointe `NODALAI_HOME` (pointProcessAt), et SEULEMENT ENSUITE charge le
// reste du banc (command.ts), dont des modules qui lisent le dossier de Nodal
// à leur chargement. Le banc lit alors la base, la configuration de services
// et les dossiers de travail de l'instance de la campagne, et de nulle autre.

import { campaignHome, describeError, newCampaignId, pointProcessAt } from './home';

async function main(): Promise<void> {
  const first = process.argv[2];
  const command = first !== undefined && !first.startsWith('--') ? first : 'run';
  // L'environnement du shell, AVANT d'y toucher : les processus de l'instance
  // en reçoivent la seule part système (instance.ts, `campaignEnv`).
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  const id = newCampaignId();
  if (command === 'run' || command === 'rehearsal') pointProcessAt(campaignHome(id));
  const { runCommand } = await import('./command');
  await runCommand(command, { id, baseEnv });
}

main().catch((e: unknown) => {
  console.error(describeError(e));
  // exitCode plutôt que exit() : sous Windows, sortir pendant que le pool se
  // ferme fait avorter libuv (UV_HANDLE_CLOSING), comme pour bench:workflows.
  process.exitCode = 2;
});

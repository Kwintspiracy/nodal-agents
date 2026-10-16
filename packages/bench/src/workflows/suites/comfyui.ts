// workflows/suites/comfyui.ts — des images générées par ComfyUI, comptées et mesurées.
//
// Le juge ne regarde pas ce qu'une image représente : il compte les fichiers
// écrits pendant l'essai à l'endroit demandé, lit leur format et leurs
// dimensions dans leur EN-TÊTE (pas dans leur nom), et vérifie que des
// variantes sont bien différentes (empreintes distinctes). Rien n'est envoyé :
// un envoi sur un canal pendant l'essai est un rouge. Besoin : `comfyui`.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileHash } from '../fixtures';
import { JUDGED_COMMON, JUDGED_NO_CHANNEL_SEND, channelSends, commonReasons } from '../judge-kit';
import { readImage } from '../office';
import { defineScenario, type AnyScenario } from '../types';

const MIN = 60_000;

interface ImageFile {
  readonly rel: string;
  readonly fresh: boolean;
  readonly type: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly hash: string;
  readonly readError: string | null;
}

interface ImagesObservation {
  readonly files: ImageFile[];
}

/** Les fichiers d'un dossier du banc, dans tous les dossiers de travail, lus comme des images. */
function observeDir(roots: readonly string[], relDir: string, sinceMs: number): ImagesObservation {
  const files: ImageFile[] = [];
  for (const root of roots) {
    const dir = join(root, relDir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      const st = statSync(p);
      if (!st.isFile()) continue;
      let view: {
        type: string | null;
        width: number | null;
        height: number | null;
        readError: string | null;
      };
      try {
        view = { ...readImage(p), readError: null };
      } catch (e) {
        view = {
          type: null,
          width: null,
          height: null,
          readError: String(e instanceof Error ? e.message : e),
        };
      }
      files.push({
        rel: `${relDir}/${name}`,
        fresh: st.mtimeMs >= sinceMs,
        hash: fileHash(p),
        ...view,
      });
    }
  }
  return { files };
}

function judgeImages(
  o: ImagesObservation,
  want: { count: number; width: number; height: number; name?: string },
): string[] {
  const r: string[] = [];
  const fresh = o.files.filter((f) => f.fresh);
  const pick = want.name ? fresh.filter((f) => f.rel.endsWith(`/${want.name}`)) : fresh;
  if (pick.length !== want.count) {
    r.push(
      `${pick.length} image file(s) written during the run${want.name ? ` named ${want.name}` : ''}, expected ${want.count}`,
    );
  }
  for (const f of pick) {
    if (f.readError !== null) r.push(`${f.rel} is not an image: ${f.readError}`);
    else {
      if (f.type !== 'png') r.push(`${f.rel} is ${f.type}, not PNG`);
      if (f.width !== want.width || f.height !== want.height)
        r.push(`${f.rel} is ${f.width} × ${f.height}, expected ${want.width} × ${want.height}`);
    }
  }
  if (new Set(pick.map((f) => f.hash)).size < pick.length) r.push('two images are the same file');
  return r;
}

function comfy(o: {
  id: string;
  title: string;
  subject: string;
  dir: string;
  name?: string;
  count: number;
  width: number;
  height: number;
}): AnyScenario {
  const where = o.name ? `${o.dir}/${o.name}` : `${o.dir}/`;
  const what =
    o.count === 1
      ? `une image de ${o.width} × ${o.height} pixels ${o.subject}, et enregistre-la dans ton espace de travail sous ${where}`
      : `${o.count} variantes différentes ${o.subject}, de ${o.width} × ${o.height} pixels, enregistrées dans ton espace de travail dans le dossier ${where} (un fichier PNG par image)`;
  return defineScenario<ImagesObservation>({
    id: o.id,
    version: 1,
    title: o.title,
    green: `Exactly ${o.count} PNG file(s)${o.name ? ` named ${o.name}` : ''} written during the run under ${o.dir}/, each ${o.width} × ${o.height} pixels read from the file header${o.count > 1 ? ', all different' : ''}, nothing sent to a messaging channel, and nobody was asked anything.`,
    set: 'on-demand',
    activity: 'image-comfyui',
    sends: 'nothing',
    needs: ['comfyui'],
    instruction: `Génère avec ComfyUI ${what}.`,
    timeoutMs: 40 * MIN,
    judgedBy: [
      ...JUDGED_COMMON,
      `lists the files written during the trial under ${o.dir}/ in every workspace folder`,
      `exactly ${o.count} PNG file(s)${o.name ? ` named ${o.name}` : ''}`,
      `width × height read from each file's header (not its name): ${o.width} × ${o.height}`,
      ...(o.count > 1 ? ['every image a different file (sha-256)'] : []),
      JUDGED_NO_CHANNEL_SEND,
    ],
    outputs: [o.dir],
    observe: async (_facts, env) => observeDir(env.workspaceRoots, o.dir, env.startedMs),
    judge(facts, ob) {
      return [
        ...commonReasons(facts),
        ...judgeImages(ob, { count: o.count, width: o.width, height: o.height, name: o.name }),
        ...channelSends(facts),
      ];
    },
  });
}

export const COMFYUI_SCENARIOS: AnyScenario[] = [
  comfy({
    id: 'comfy-square',
    title: 'One square image from ComfyUI, at the size asked',
    subject: "d'un phare sur une falaise au coucher du soleil",
    dir: 'nodal-bench/comfy-phare',
    name: 'phare.png',
    count: 1,
    width: 1024,
    height: 1024,
  }),
  comfy({
    id: 'comfy-variants',
    title: 'Three different variants from ComfyUI',
    subject: "d'un chat roux qui dort sur un rebord de fenêtre",
    dir: 'nodal-bench/comfy-variantes',
    count: 3,
    width: 768,
    height: 768,
  }),
  comfy({
    id: 'comfy-portrait',
    title: 'A portrait-format image from ComfyUI',
    subject: "d'un astronaute dans une forêt",
    dir: 'nodal-bench/comfy-portrait',
    name: 'astronaute.png',
    count: 1,
    width: 768,
    height: 1152,
  }),
  comfy({
    id: 'comfy-landscape',
    title: 'A landscape-format image from ComfyUI',
    subject: "d'une ville futuriste la nuit",
    dir: 'nodal-bench/comfy-paysage',
    name: 'ville.png',
    count: 1,
    width: 1216,
    height: 832,
  }),
];

'use client';

// DeliveryMedia — UN MÉDIA LIVRÉ, MONTRÉ DANS L'ENCART (#490).
//
// « Il faudrait que la carte Delivered affiche le média, lorsque c'est un
// média qui est livré. Une image, une vidéo, une piste audio. Pouvoir les lire
// depuis la carte et les télécharger. » (Quentin, 25/09)
//
// Une image, une piste ou une vidéo n'a pas de diff : sa plaque disait « no
// text recorded », et il fallait ouvrir le dossier sur le disque pour écouter
// ce que `generate_speech` venait d'écrire. Ce bloc prend la place de la
// plaque : la même rangée (le geste, le chemin), et dessous le média lui-même.
//
// OUVERT D'ENTRÉE, contrairement aux plaques de diff : un diff se lit quand on
// le cherche, un média livré est la réponse.
//
// Le fichier arrive par `/api/runs/<jobId>/media`, qui ne sert que ce que ce
// travail a écrit (`lib/delivered-media.ts`). Quand il ne peut pas, le bloc dit
// pourquoi au lieu de laisser un lecteur muet (invariant #4).

import { useState } from 'react';
import { DownloadSimple, FilmStrip, Image as ImageIcon, SpeakerHigh } from '@phosphor-icons/react';
import RowActionButton from '@/components/ui/RowActionButton';
import { GESTE_LIBELLE } from '@/app/(dashboard)/code/[id]/FileChangeBlock.tsx';
import { deliveredMediaUrl, type MediaKind } from '@/lib/media-kinds.ts';
import type { DeliveryFileChange } from '@/lib/conversation-feed.ts';

const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon,
  audio: SpeakerHigh,
  video: FilmStrip,
};

/** Ce que dit le bloc quand la route refuse, par code (`lib/delivered-media.ts`). */
const REFUSAL_NOTE: Readonly<Record<string, string>> = {
  gone: 'This file is no longer on disk.',
  not_delivered: 'This run did not deliver this file.',
  outside: 'This file is outside the workspace folders.',
  ambiguous: 'Two folders hold a file at this path.',
  not_media: 'This file cannot be previewed.',
  job_not_found: 'Run not found.',
  unauthorized: 'Sign in to see this file.',
};

export default function DeliveryMedia({
  file,
  kind,
  jobId,
  rank,
}: {
  file: DeliveryFileChange;
  kind: MediaKind;
  jobId: string;
  /** Le rang de ce fichier parmi ceux qui portent le même chemin affiché (#380). */
  rank: number;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const src = deliveredMediaUrl(jobId, file.path, rank);
  const Icon = KIND_ICON[kind];

  // Un `<img>` ou un `<audio>` en échec ne dit pas pourquoi : la réponse de la
  // route, elle, le dit. On la relit une fois, sur un octet.
  const explain = (): void => {
    if (failure !== null) return;
    setFailure('Loading the reason…');
    void fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then(async (res) => {
        if (res.ok) {
          setFailure('Your browser cannot play this file.');
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const code = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
        setFailure(REFUSAL_NOTE[code] ?? `Cannot show this file (${code}).`);
      })
      .catch(() => setFailure('Cannot reach the dashboard server.'));
  };

  return (
    <div
      className="w-full bg-paper border-b border-rule-2 first:border-t last:border-b-0"
      data-testid="delivery-media"
      data-media-kind={kind}
    >
      <div className="flex h-[42px] w-full items-center gap-2 px-3">
        <span className="flex w-3.5 shrink-0 items-center text-ink-4" aria-hidden>
          <Icon size={14} />
        </span>
        <span className="shrink-0 text-mono-12 font-bold text-feed-tool">
          {GESTE_LIBELLE[file.changeKind ?? 'added']}
        </span>
        {/* Tronqué par la GAUCHE, comme la plaque : la fin porte le nom. */}
        <span
          dir="rtl"
          title={file.path}
          className="min-w-0 flex-1 truncate text-left text-mono-12 text-feed-path"
        >
          <bdi dir="ltr">{file.path}</bdi>
        </span>
        <RowActionButton
          square
          href={deliveredMediaUrl(jobId, file.path, rank, true)}
          download
          title="Download"
          icon={<DownloadSimple size={14} weight="bold" />}
        />
      </div>
      <div className="border-t border-rule-2 bg-code-bg px-3 py-3">
        {failure !== null ? (
          <p className="text-mono-11 text-ink-4" data-testid="delivery-media-failure">
            {failure}
          </p>
        ) : kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element -- a run's file, served by our own route: next/image would copy it through the image optimiser.
          <img
            src={src}
            alt={file.path}
            onError={explain}
            className="max-h-80 max-w-full rounded-md border border-rule-2"
          />
        ) : kind === 'audio' ? (
          <audio controls preload="metadata" src={src} onError={explain} className="w-full" />
        ) : (
          <video
            controls
            preload="metadata"
            src={src}
            onError={explain}
            className="max-h-[360px] max-w-full rounded-md"
          />
        )}
      </div>
    </div>
  );
}

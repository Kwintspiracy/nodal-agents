// media-kinds.ts — QUELS FICHIERS LIVRÉS SE MONTRENT DANS L'ENCART (#490).
//
// L'encart de livraison dessinait un diff par fichier ; une image, une piste
// audio ou une vidéo n'en ont pas, et leur plaque disait « no text recorded ».
// Un fichier dont l'extension est ici se montre à la place : l'image, le
// lecteur, et de quoi le télécharger.
//
// UNE LISTE FERMÉE, et c'est elle qui décide aussi de ce que la route sert :
// le type envoyé au navigateur vient d'ici, jamais du contenu du fichier.
// Le SVG n'y est pas : c'est un document qui peut porter du script, et le
// servir depuis l'origine du tableau de bord l'exécuterait chez la personne.

export type MediaKind = 'image' | 'audio' | 'video';

export const MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; contentType: string }>> = {
  '.png': { kind: 'image', contentType: 'image/png' },
  '.jpg': { kind: 'image', contentType: 'image/jpeg' },
  '.jpeg': { kind: 'image', contentType: 'image/jpeg' },
  '.webp': { kind: 'image', contentType: 'image/webp' },
  '.gif': { kind: 'image', contentType: 'image/gif' },
  '.wav': { kind: 'audio', contentType: 'audio/wav' },
  '.mp3': { kind: 'audio', contentType: 'audio/mpeg' },
  '.ogg': { kind: 'audio', contentType: 'audio/ogg' },
  '.m4a': { kind: 'audio', contentType: 'audio/mp4' },
  '.mp4': { kind: 'video', contentType: 'video/mp4' },
  '.webm': { kind: 'video', contentType: 'video/webm' },
};

/** L'extension, en minuscules, point compris ; '' sans extension. */
function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Le type de média d'un chemin, ou null si ce n'est pas un média montrable. */
export function mediaTypeOfPath(path: string): { kind: MediaKind; contentType: string } | null {
  return MEDIA_TYPES[extensionOf(path)] ?? null;
}

/**
 * L'adresse du fichier livré, par la route qui le sert. Le fichier se désigne
 * par son chemin AFFICHÉ et son rang parmi les fichiers de ce chemin — le même
 * couple que `DeliveryFiles` utilise déjà (#380) : le chemin brut ne sort
 * jamais du serveur (#161).
 */
export function deliveredMediaUrl(
  jobId: string,
  path: string,
  rank: number,
  download = false,
): string {
  const q = new URLSearchParams({ path, n: String(rank) });
  if (download) q.set('download', '1');
  return `/api/runs/${encodeURIComponent(jobId)}/media?${q.toString()}`;
}

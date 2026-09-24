'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import RowActionButton from '@/components/ui/RowActionButton';
import { browseServerFoldersAction, type ServerFolderListing } from '@/lib/actions.ts';

/**
 * FolderPickerModal — l'explorateur de dossiers CÔTÉ SERVEUR du bouton
 * « Browse » (Knowledge → Add folder). Le navigateur web ne peut pas livrer
 * le chemin absolu d'un dossier local (sandbox) ; le serveur Nodal tourne sur
 * la machine hôte, donc c'est lui qui liste lecteurs et dossiers et la modale
 * navigue dedans (pattern Jellyfin/Portainer). Owner-only côté action.
 */
export default function FolderPickerModal({
  open,
  startPath = null,
  onClose,
  onSelect,
}: {
  open: boolean;
  /** Le dossier où s'ouvrir ; à défaut, les racines. */
  startPath?: string | null;
  onClose: () => void;
  /**
   * Reçoit le chemin absolu du dossier choisi. La fenêtre attend sa fin avant
   * de se fermer, et n'accepte pas un second choix entre-temps : un double
   * clic ne doit pas attacher deux fois (#461).
   */
  onSelect: (path: string) => void | Promise<void>;
}) {
  const [listing, setListing] = useState<ServerFolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  // Le verrou vit aussi dans une ref : deux clics dans le même tick lisent
  // encore l'ancien `selecting`.
  const selectingRef = useRef(false);

  const browse = useCallback(async (path: string | null): Promise<boolean> => {
    setLoading(true);
    setError(null);
    let result: Awaited<ReturnType<typeof browseServerFoldersAction>>;
    try {
      result = await browseServerFoldersAction(path);
    } catch (err) {
      // Un REJET ne doit pas laisser la fenêtre sur « Loading… » (revue passe 3).
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
    if (!result.ok) {
      // Un dossier illisible (droits OS) ne doit pas éjecter l'utilisateur de
      // la navigation : on affiche l'erreur et on reste sur la vue courante.
      setError(result.message);
      return false;
    }
    setListing(result.data);
    return true;
  }, []);

  // Lu À L'OUVERTURE seulement : un `startPath` qui change fenêtre ouverte (le
  // refus d'un ajout le pose) ne doit pas relancer la navigation.
  const openAtStart = useEffectEvent(async () => {
    selectingRef.current = false;
    setSelecting(false);
    if (!startPath) {
      await browse(null);
      return;
    }
    if (await browse(startPath)) return;
    // Le dossier de départ a disparu : les racines, et on dit pourquoi.
    await browse(null);
    setError(`${startPath} can no longer be opened. Pick the folder again.`);
  });

  // (Re)charge le dossier de départ à chaque ouverture. browse() pose du state : la
  // règle set-state-in-effect interdit de l'appeler dans le CORPS de l'effet,
  // donc l'appel part dans une microtâche annulable (même esprit que le
  // load() de ServiceLogsPanel — le state n'est posé que dans une callback).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void openAtStart();
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function select(path: string) {
    if (selectingRef.current) return;
    selectingRef.current = true;
    setSelecting(true);
    setError(null);
    try {
      await onSelect(path);
      onClose();
    } catch (err) {
      // Un REJET (serveur qui redémarre, réseau coupé) n'est pas un refus : le
      // dossier n'est pas attaché, et fermer la fenêtre le cacherait (revue
      // Reviewer A, passe 2). Elle reste ouverte, dit pourquoi, et Select
      // redevient cliquable.
      setError(`The folder was not added: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      selectingRef.current = false;
      setSelecting(false);
    }
  }

  const atPath = listing?.path ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      // Pendant l'ajout, ni Esc ni clic à côté : fermer n'arrêterait pas
      // l'écriture, qui aboutirait sans que la fenêtre l'ait montré.
      dismissable={!selecting}
      title="Choose a folder"
      className="!max-w-xl"
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" onClick={onClose} disabled={selecting}>
            Cancel
          </PrimaryButton>
          <PrimaryButton
            onClick={() => {
              if (atPath) void select(atPath);
            }}
            disabled={!atPath || loading || selecting}
          >
            {selecting ? 'Adding…' : 'Select this folder'}
          </PrimaryButton>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        {/* Barre de navigation : Up + Home + chemin courant */}
        <div className="flex items-center gap-2">
          <PrimaryButton
            variant="neutral"
            size="sm"
            onClick={() => void browse(listing?.parent ?? null)}
            disabled={loading || !listing || (atPath === null && !listing?.parent)}
          >
            ↑ Up
          </PrimaryButton>
          <PrimaryButton
            variant="neutral"
            size="sm"
            onClick={() => listing && void browse(listing.home)}
            disabled={loading || !listing}
          >
            Home
          </PrimaryButton>
          <code className="min-w-0 flex-1 truncate rounded-lg border border-rule-2 bg-hover px-3 py-1.5 text-mono-12 text-ink-2">
            {atPath ?? 'Drives'}
          </code>
        </div>

        {error && (
          <p className="rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-body-13 text-err">
            {error}
          </p>
        )}

        {/* Liste des dossiers */}
        <div className="h-64 overflow-y-auto rounded-lg border border-rule bg-canvas">
          {loading ? (
            <p className="px-3 py-2 text-body-13 text-ink-4">Loading…</p>
          ) : !listing ? null : listing.dirs.length === 0 ? (
            <p className="px-3 py-2 text-body-13 text-ink-4">No subfolders.</p>
          ) : (
            <ul>
              {listing.dirs.map((d) => (
                <li key={d.path}>
                  <RowActionButton
                    onClick={() => void browse(d.path)}
                    className="!h-auto !w-full !justify-start !rounded-none !border-transparent !bg-transparent !px-3 !py-1.5 !text-body-13"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden="true">📁</span>
                      <span className="min-w-0 truncate font-mono">{d.name}</span>
                    </span>
                  </RowActionButton>
                </li>
              ))}
            </ul>
          )}
          {listing?.truncated && (
            <p className="px-3 py-2 text-body-12 text-ink-4">
              List truncated to 500 folders. Navigate deeper or type the path directly.
            </p>
          )}
        </div>

        <p className="text-body-12 text-ink-4">
          Browsing the folders of the machine Nodal runs on. Only folder names are read.
        </p>
      </div>
    </Modal>
  );
}

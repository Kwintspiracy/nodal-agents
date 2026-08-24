'use client';

import { useCallback, useEffect, useState } from 'react';
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
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  /** Reçoit le chemin absolu du dossier choisi. */
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<ServerFolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (path: string | null) => {
    setLoading(true);
    setError(null);
    const result = await browseServerFoldersAction(path);
    setLoading(false);
    if (!result.ok) {
      // Un dossier illisible (droits OS) ne doit pas éjecter l'utilisateur de
      // la navigation : on affiche l'erreur et on reste sur la vue courante.
      setError(result.message);
      return;
    }
    setListing(result.data);
  }, []);

  // (Re)charge les racines à chaque ouverture. browse() pose du state : la
  // règle set-state-in-effect interdit de l'appeler dans le CORPS de l'effet,
  // donc l'appel part dans une microtâche annulable (même esprit que le
  // load() de ServiceLogsPanel — le state n'est posé que dans une callback).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void browse(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, browse]);

  const atPath = listing?.path ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a folder"
      className="!max-w-xl"
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" onClick={onClose}>
            Cancel
          </PrimaryButton>
          <PrimaryButton
            onClick={() => {
              if (!atPath) return;
              onSelect(atPath);
              onClose();
            }}
            disabled={!atPath || loading}
          >
            Select this folder
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

'use client';

/**
 * ProjectVerificationPanel — les commandes de preuve d'UN projet, sur l'écran
 * du projet (plan « Vérifier & Corriger », T22 / D9).
 *
 * OÙ. Pas de route neuve : un projet est DÉRIVÉ, jamais stocké, et son
 * identité est un chemin absolu — l'encoder dans une URL est un piège Windows
 * (lettre de lecteur, UNC). Le panneau vit donc dans la branche `openProject`
 * de CodeProcessesTable, le seul écran de l'app qui soit celui du PROJET.
 *
 * CE QUE ÇA ENGAGE. Une commande de preuve est un POUVOIR : elle s'exécute sur
 * cette machine, avec le compte de l'utilisateur, et un agent qui modifie
 * package.json contrôle ce que `pnpm test` lance. D'où deux gestes séparés —
 * écrire la liste, puis l'approuver — et l'avertissement en toutes lettres
 * avant l'approbation.
 *
 * AUCUN OPTIMISME (inv. #4). Le pattern optimiste + revert de `toggleHidden`
 * convient à un réglage d'affichage, pas à une porte de sécurité : ici on
 * persiste, on RELIT `listCodeProjectPrefsAction`, et on affiche ce que le
 * serveur rend. Sur échec, un toast et l'écran reste sur l'état d'avant — le
 * brouillon saisi est conservé, mais le statut affiché ne bouge pas d'un cran.
 *
 * LE HASH NE SE CALCULE JAMAIS ICI. `verifyManifestHash` arrive du serveur et
 * repart tel quel à l'approbation : c'est un jeton de concurrence optimiste.
 * Le serveur relit la ligne, recalcule, compare, et écrit SA valeur.
 *
 * LES DEUX CAPS SONT VISIBLES, pas seulement refusés au serveur : l'ajout
 * disparaît à cinq commandes, le retrait disparaît quand il n'en reste qu'une
 * (l'action serveur exige 1 à 5 — un brouillon vide serait un cul-de-sac).
 */

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, X } from '@phosphor-icons/react/dist/ssr';
import {
  approveCodeProjectVerifyManifestAction,
  discoverVerifyCommandsAction,
  listCodeProjectPrefsAction,
  setCodeProjectVerifyCommandsAction,
  type CodeProjectPrefs,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Banner from '@/components/ui/Banner';
import EdRow, { IcBtn } from '@/components/ui/EdRow';
import EdAddButton from '@/components/ui/EdAddButton';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import { VERIFY_COMMANDS_MAX, type VerifyCommand } from '@nodal-agents/shared';
import { relativeTime } from '@/lib/format-time';

/** Ce que la table porte pour un projet — un sous-ensemble des prefs serveur. */
export type ProjectVerification = Pick<
  CodeProjectPrefs,
  'verifyCommands' | 'verifyApprovedAt' | 'verifyManifestHash' | 'verifyStatus'
>;

/** Une ligne du brouillon : le timeout est du TEXTE tant qu'il est saisi. */
type Draft = { command: string; timeout: string };

/** Cinq minutes — un `pnpm test` ordinaire tient dedans sans être infini. */
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_COMMAND_LENGTH = 2000;

function toDraft(commands: readonly VerifyCommand[] | null): Draft[] {
  return (commands ?? []).map((c) => ({ command: c.command, timeout: String(c.timeoutSeconds) }));
}

/** Le timeout saisi, ou `null` s'il n'est pas un entier de 1 à 3600. */
function parseTimeout(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT_SECONDS) return null;
  return n;
}

/**
 * Le brouillon en commandes typées, ou `null` s'il ne peut pas être écrit.
 * Mêmes bornes que le zod du serveur (VerifyCommandSchema) : la validation
 * client ÉVITE un aller-retour, elle ne remplace pas celle du serveur.
 */
function toCommands(draft: readonly Draft[]): VerifyCommand[] | null {
  if (draft.length === 0 || draft.length > VERIFY_COMMANDS_MAX) return null;
  const out: VerifyCommand[] = [];
  for (const d of draft) {
    const command = d.command.trim();
    const timeoutSeconds = parseTimeout(d.timeout);
    if (command === '' || command.length > MAX_COMMAND_LENGTH || timeoutSeconds === null) {
      return null;
    }
    out.push({ command, timeoutSeconds });
  }
  return out;
}

/** Signature textuelle d'une liste — sert à comparer brouillon et serveur. */
function signature(rows: readonly { command: string; timeout: string }[]): string {
  return JSON.stringify(rows.map((r) => [r.command.trim(), r.timeout.trim()]));
}

export default function ProjectVerificationPanel({
  projectPath,
  verification,
  isOwner,
  onPrefsReloaded,
}: {
  /** Le chemin absolu du projet. Le tiroir « Other sessions » n'en a pas, et
   *  n'a donc pas de panneau du tout — voir CodeProcessesTable. */
  projectPath: string;
  /** L'état SERVEUR du projet, ou `null` quand aucune ligne n'existe encore. */
  verification: ProjectVerification | null;
  /** Vient du serveur (getCodeTabOwnerAction), jamais déduit ici. */
  isOwner: boolean;
  /** Remonte les prefs RELUES après chaque écriture réussie. */
  onPrefsReloaded: (prefs: CodeProjectPrefs[]) => void;
}) {
  const serverCommands = verification?.verifyCommands ?? null;
  const status = verification?.verifyStatus ?? 'not_configured';

  const [draft, setDraft] = useState<Draft[]>(() => toDraft(serverCommands));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, startTransition] = useTransition();
  /** Les propositions lues dans le projet — `null` tant qu'on n'a pas cherché. */
  const [suggested, setSuggested] = useState<Draft[] | null>(null);

  // Resynchronisation sur l'état SERVEUR quand il change (après une écriture
  // réussie, la relecture remonte jusqu'ici). Reset dérivé au rendu, le
  // pendant documenté de getDerivedStateFromProps — même pattern que
  // ConfirmDialog pour son champ de confirmation.
  const serverSig = signature(toDraft(serverCommands));
  const [prevServerSig, setPrevServerSig] = useState(serverSig);
  if (prevServerSig !== serverSig) {
    setPrevServerSig(serverSig);
    setDraft(toDraft(serverCommands));
  }

  // LES PROPOSITIONS (v7-C). Le projet dit lui-même ce qu'il lance pour se
  // prouver : `package.json` porte ses scripts, `Cargo.toml` et `go.mod`
  // désignent leur outil. On ne le demande donc pas — on le lit, et on
  // pré-remplit. L'utilisateur qui a cliqué « Add a command » sans savoir quoi
  // taper n'avait pas tort : rien ne le lui disait.
  //
  // Uniquement quand RIEN n'est configuré : un projet déjà réglé ne se fait pas
  // réécrire par une découverte. Et jamais pour un non-propriétaire, qui ne
  // pourrait rien en faire.
  const unconfigured = serverCommands === null || serverCommands.length === 0;
  useEffect(() => {
    if (!isOwner || !unconfigured) return;
    let annule = false;
    void (async () => {
      const res = await discoverVerifyCommandsAction({ projectPath });
      if (annule) return;
      // Un échec de lecture ne dit rien de faux : aucune proposition, et
      // l'écran garde son état d'avant.
      setSuggested(
        res.ok
          ? res.data.map((c) => ({ command: c.command, timeout: String(c.timeoutSeconds) }))
          : [],
      );
    })();
    return () => {
      annule = true;
    };
  }, [projectPath, isOwner, unconfigured]);

  const commands = toCommands(draft);
  const dirty = signature(draft) !== serverSig;
  // Éditable = propriétaire ET aucune écriture en vol. Pendant une écriture,
  // les gestes de ligne ne sont pas rendus : la relecture qui suit remplace le
  // brouillon, et un réordonnancement fait entre-temps serait perdu en
  // silence.
  const editable = isOwner && !busy;

  function update(index: number, patch: Partial<Draft>) {
    setDraft((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function move(index: number, delta: number) {
    setDraft((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(index, 1);
      if (!row) return prev;
      next.splice(target, 0, row);
      return next;
    });
  }

  function remove(index: number) {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  }

  function add() {
    setDraft((prev) =>
      prev.length >= VERIFY_COMMANDS_MAX
        ? prev
        : [...prev, { command: '', timeout: String(DEFAULT_TIMEOUT_SECONDS) }],
    );
  }

  /** Relit les prefs et les remonte. Une relecture en échec le DIT. */
  async function reload(): Promise<boolean> {
    const fresh = await listCodeProjectPrefsAction();
    if (!fresh.ok) {
      toast.error(fresh.message);
      return false;
    }
    onPrefsReloaded(fresh.data);
    return true;
  }

  function save() {
    // Même garde que les deux autres gestes du projet : sans chemin, écrire
    // créerait une ligne code_projects pour un projet qui n'existe pas.
    if (!projectPath) return;
    const payload = commands;
    if (!payload) return;
    startTransition(async () => {
      const r = await setCodeProjectVerifyCommandsAction({ projectPath, commands: payload });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (await reload()) toast.success('Proof commands saved. They need your approval.');
    });
  }

  function approve() {
    setConfirmOpen(false);
    if (!projectPath) return;
    const token = verification?.verifyManifestHash;
    if (!token) return;
    startTransition(async () => {
      const r = await approveCodeProjectVerifyManifestAction({
        projectPath,
        manifestHash: token,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (await reload()) toast.success('Proof commands approved.');
    });
  }

  const statusTag =
    status === 'approved' ? (
      <MonoMicroTag tone="skill">
        Approved {relativeTime(verification?.verifyApprovedAt)}
      </MonoMicroTag>
    ) : status === 'pending_approval' ? (
      <MonoMicroTag tone="warn">Needs your approval</MonoMicroTag>
    ) : (
      <MonoMicroTag tone="ink">Not configured</MonoMicroTag>
    );

  return (
    <section
      data-testid="project-verification"
      className="space-y-3 rounded-xl border border-rule-2 bg-paper px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-medium-14 text-ink">Proof commands</span>
        <span data-testid="verify-status">{statusTag}</span>
        {!isOwner && <MonoMicroTag tone="err">owner only</MonoMicroTag>}
      </div>
      <p className="text-body-13 leading-[1.4]! text-ink-3">
        Commands that run in this folder after a coding task, in order. Nothing is blocked yet: the
        runs are recorded so you can read them.
      </p>
      {!isOwner && (
        <p className="text-body-12 text-ink-4">
          Only the workspace owner can change proof commands.
        </p>
      )}

      {draft.length === 0 && suggested !== null && suggested.length > 0 && (
        <div className="space-y-2 rounded-lg border border-rule-2 p-3">
          <p className="text-body-13 text-ink-2">Found in this project. Add them, then approve.</p>
          <ul className="space-y-1">
            {suggested.map((sug, i) => (
              <li key={i} className="font-mono text-body-12 text-ink-3">
                {sug.command}
              </li>
            ))}
          </ul>
          <PrimaryButton
            type="button"
            disabled={!editable}
            data-testid="verify-use-suggested"
            onClick={() => setDraft(suggested)}
          >
            Add these
          </PrimaryButton>
        </div>
      )}

      {draft.length === 0 ? (
        <p className="text-body-13 text-ink-4">
          {suggested !== null && suggested.length === 0
            ? 'No proof commands yet, and nothing to suggest: this folder has no manifest Nodal reads.'
            : 'No proof commands yet.'}
        </p>
      ) : (
        <div className="space-y-2">
          {draft.map((d, i) => (
            <EdRow
              // Une commande n'a pas d'identité propre : sa place EST son
              // identité, et déplacer une ligne doit rendre la nouvelle place.
              key={i}
              name={
                <TextInput
                  value={d.command}
                  disabled={!editable}
                  maxLength={MAX_COMMAND_LENGTH}
                  spellCheck={false}
                  placeholder="pnpm test"
                  aria-label={`Proof command ${i + 1}`}
                  data-testid={`verify-command-${i}`}
                  onChange={(e) => update(i, { command: e.target.value })}
                />
              }
              meta={
                <span className="flex items-center gap-1.5">
                  <span>#{i + 1}</span>
                  <TextInput
                    value={d.timeout}
                    disabled={!editable}
                    inputMode="numeric"
                    maxLength={4}
                    aria-label={`Timeout in seconds for command ${i + 1}`}
                    data-testid={`verify-timeout-${i}`}
                    containerClassName="w-14"
                    onChange={(e) => update(i, { timeout: e.target.value })}
                  />
                  <span>s</span>
                </span>
              }
              actions={
                editable ? (
                  <>
                    {i > 0 && (
                      <IcBtn
                        title="Move up"
                        ariaLabel={`Move command ${i + 1} up`}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp size={12} />
                      </IcBtn>
                    )}
                    {i < draft.length - 1 && (
                      <IcBtn
                        title="Move down"
                        ariaLabel={`Move command ${i + 1} down`}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown size={12} />
                      </IcBtn>
                    )}
                    {draft.length > 1 && (
                      <IcBtn
                        title="Remove"
                        ariaLabel={`Remove command ${i + 1}`}
                        onClick={() => remove(i)}
                      >
                        <X size={12} />
                      </IcBtn>
                    )}
                  </>
                ) : undefined
              }
            />
          ))}
        </div>
      )}

      {editable && draft.length < VERIFY_COMMANDS_MAX && (
        <EdAddButton size="sm" onClick={add}>
          Add a command
        </EdAddButton>
      )}

      {isOwner && (
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton
            size="sm"
            onClick={save}
            disabled={!dirty || commands === null || busy}
            data-testid="verify-save"
          >
            Save
          </PrimaryButton>
          {dirty && commands === null && (
            <span className="text-body-12 text-ink-4">
              Every command needs text and a timeout from 1 to {MAX_TIMEOUT_SECONDS} seconds.
            </span>
          )}
        </div>
      )}

      {status === 'pending_approval' && (
        <Banner variant="warn" title="Approval needed" className="mt-1">
          These commands run code from the repository on this machine, with your account. Approve
          only what you would run yourself.
        </Banner>
      )}

      {status === 'pending_approval' && isOwner && (
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton
            size="sm"
            variant="neutral"
            onClick={() => setConfirmOpen(true)}
            disabled={dirty || busy || !verification?.verifyManifestHash}
            data-testid="verify-approve"
          >
            Approve
          </PrimaryButton>
          {dirty && <span className="text-body-12 text-ink-4">Save your changes first.</span>}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Approve these proof commands?"
        message="These commands run code from the repository on this machine, with your account. Approve only what you would run yourself."
        confirmLabel="Approve"
        destructive={false}
        extra={
          <ol className="space-y-1">
            {(serverCommands ?? []).map((c, i) => (
              <li key={i} className="flex items-baseline gap-2 text-mono-12">
                <span className="text-ink-4">{i + 1}.</span>
                <span className="min-w-0 flex-1 break-all text-ink-2">{c.command}</span>
                <span className="text-ink-4">{c.timeoutSeconds}s</span>
              </li>
            ))}
          </ol>
        }
        onConfirm={approve}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}

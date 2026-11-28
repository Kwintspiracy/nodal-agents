// liveness.test.ts — la décision unique des faucheurs (#1204), sans base.
//
// `decideJob` est pure : ces cas prouvent la règle elle-même, pour chaque
// statut que les faucheurs regardent. Les lignes réelles sont prouvées dans
// tests/cron/job-liveness.test.ts.

import { describe, it, expect } from 'vitest';
import {
  BeatRecord,
  JOB_LIVENESS,
  StuckRows,
  createPresence,
  decideJob,
  enterRun,
  isRunInFlight,
  judgeHolder,
} from '../../job/liveness.ts';
import type { Holder } from '../../job/liveness.ts';

const MOI = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-11-28T10:00:00.000Z');

function presence(opts: { tient?: string[]; presenteDepuisMs?: number } = {}) {
  const beats = new BeatRecord();
  if (opts.presenteDepuisMs !== undefined) {
    // Des battements toutes les 60 s jusqu'à T0, sans trou.
    for (let t = T0.getTime() - opts.presenteDepuisMs; t <= T0.getTime(); t += 60_000) {
      beats.record(new Date(t));
    }
    beats.record(T0);
  }
  const tenus = new Set(opts.tient ?? []);
  return createPresence({ instanceId: MOI, holds: (id) => tenus.has(id), beats });
}

function il(ms: number): Date {
  return new Date(T0.getTime() - ms);
}

describe('judgeHolder : vivant = tenu par une instance qui tourne @cap:parler-a-un-agent/moteur', () => {
  it('cette instance, et un de ses runs exécute le job : tenu', () => {
    const h = judgeHolder(
      { jobId: 'j', claimedBy: MOI, record: null, dbNow: T0 },
      presence({ tient: ['j'] }),
    );
    expect(h).toEqual({ kind: 'self', held: true });
  });

  it('cette instance, et aucun de ses runs ne l’exécute : pas tenu', () => {
    const h = judgeHolder({ jobId: 'j', claimedBy: MOI, record: null, dbNow: T0 }, presence());
    expect(h).toEqual({ kind: 'self', held: false });
  });

  it('une autre instance qui bat : vivante, quel que soit l’âge du job', () => {
    const h = judgeHolder(
      {
        jobId: 'j',
        claimedBy: AUTRE,
        record: { lastSeenAt: il(10_000), stoppedAt: null },
        dbNow: T0,
      },
      presence({ presenteDepuisMs: 600_000 }),
    );
    expect(h).toEqual({ kind: 'alive', id: AUTRE, lastSeenAt: il(10_000) });
  });

  it('une autre instance muette, vue par une instance présente depuis assez longtemps : partie', () => {
    const h = judgeHolder(
      {
        jobId: 'j',
        claimedBy: AUTRE,
        record: { lastSeenAt: il(JOB_LIVENESS.silentInstanceMs + 1_000), stoppedAt: null },
        dbNow: T0,
      },
      presence({ presenteDepuisMs: JOB_LIVENESS.silentInstanceMs + 60_000 }),
    );
    expect(h).toMatchObject({ kind: 'gone', how: 'silent', id: AUTRE });
  });

  it('la même instance muette, vue par une instance qui vient de se réveiller : rien n’est décidé', () => {
    // L'observateur a dormi (ou vient de démarrer) : il n'a aucune présence
    // sans trou pour juger le silence d'un autre.
    const beats = new BeatRecord();
    beats.record(il(3_600_000)); // un battement avant le sommeil
    beats.record(T0); // le premier au réveil : un trou d'une heure
    const p = createPresence({ instanceId: MOI, holds: () => false, beats });
    const h = judgeHolder(
      {
        jobId: 'j',
        claimedBy: AUTRE,
        record: { lastSeenAt: il(3_600_000), stoppedAt: null },
        dbNow: T0,
      },
      p,
    );
    expect(h).toEqual({ kind: 'undecided', id: AUTRE, lastSeenAt: il(3_600_000) });
  });

  it('arrêtée proprement : partie aussitôt, même si son dernier battement est frais', () => {
    const h = judgeHolder(
      {
        jobId: 'j',
        claimedBy: AUTRE,
        record: { lastSeenAt: il(5_000), stoppedAt: il(4_000) },
        dbNow: T0,
      },
      presence(),
    );
    expect(h).toMatchObject({ kind: 'gone', how: 'stopped', stoppedAt: il(4_000) });
  });

  it('sans inscription, ou sans détenteur inscrit : parti', () => {
    expect(
      judgeHolder({ jobId: 'j', claimedBy: AUTRE, record: null, dbNow: T0 }, presence()),
    ).toMatchObject({ kind: 'gone', how: 'no_record' });
    expect(
      judgeHolder({ jobId: 'j', claimedBy: null, record: null, dbNow: T0 }, presence()),
    ).toMatchObject({ kind: 'gone', how: 'none', id: null });
  });
});

describe('BeatRecord : la présence d’une instance, sur l’horloge de la base', () => {
  it('sans trou depuis 5 minutes : présente depuis 5 minutes', () => {
    const b = new BeatRecord();
    for (let t = 300_000; t >= 0; t -= 60_000) b.record(il(t));
    expect(b.presentFor(T0)).toBe(300_000);
  });

  it('un trou plus long que la fenêtre interrompt la présence', () => {
    const b = new BeatRecord();
    b.record(il(900_000));
    b.record(il(840_000));
    b.record(il(10_000)); // 830 s plus tard
    expect(b.presentFor(T0)).toBe(10_000);
  });

  it('une horloge qui recule interrompt la présence', () => {
    const b = new BeatRecord();
    b.record(il(200_000));
    b.record(il(140_000));
    b.record(il(170_000)); // recule de 30 s
    expect(b.presentFor(il(110_000))).toBe(60_000);
  });

  it('un dernier battement trop vieux ne répond plus du présent', () => {
    const b = new BeatRecord();
    for (let t = 600_000; t >= 300_000; t -= 60_000) b.record(il(t));
    expect(b.presentFor(T0)).toBe(0);
  });
});

describe('StuckRows : une ligne vue inchangée, sur l’horloge monotone', () => {
  it('première vue : null ; même état plus tard : la durée ; état changé : on recommence', () => {
    const s = new StuckRows();
    expect(s.observe([{ id: 'a', signature: 'x' }], 1_000).get('a')).toBeNull();
    expect(s.observe([{ id: 'a', signature: 'x' }], 41_000).get('a')).toBe(40_000);
    expect(s.observe([{ id: 'a', signature: 'y' }], 50_000).get('a')).toBeNull();
    // Absente d'une passe : oubliée.
    s.observe([], 60_000);
    expect(s.observe([{ id: 'a', signature: 'y' }], 70_000).get('a')).toBeNull();
  });
});

describe('enterRun : les runs que CE processus exécute', () => {
  it('compté, et rendu une seule fois', () => {
    const sortir1 = enterRun('job-x');
    const sortir2 = enterRun('job-x');
    sortir1();
    sortir1();
    expect(isRunInFlight('job-x')).toBe(true);
    sortir2();
    expect(isRunInFlight('job-x')).toBe(false);
  });
});

describe('decideJob : une décision pour tous les faucheurs @cap:parler-a-un-agent/moteur', () => {
  const parti: Holder = {
    kind: 'gone',
    id: AUTRE,
    how: 'stopped',
    lastSeenAt: null,
    stoppedAt: T0,
  };
  const vieux = JOB_LIVENESS.stuckRowMs;

  it('processing : un job tenu, vivant ou indécis n’est jamais repris, quel que soit son âge', () => {
    const base = { status: 'processing' as const, onBoard: false, stuckForMs: 10 * 3_600_000 };
    expect(decideJob({ ...base, holder: { kind: 'self', held: true } })).toEqual({
      kind: 'leave',
      because: 'in_flight_here',
    });
    expect(decideJob({ ...base, holder: { kind: 'alive', id: AUTRE, lastSeenAt: T0 } }).kind).toBe(
      'leave',
    );
    expect(
      decideJob({ ...base, holder: { kind: 'undecided', id: AUTRE, lastSeenAt: T0 } }),
    ).toEqual({ kind: 'leave', because: 'holder_undecided' });
  });

  it('processing : un détenteur parti est repris ; un tableau ouvert protège', () => {
    expect(
      decideJob({ status: 'processing', holder: parti, onBoard: false, stuckForMs: null }),
    ).toEqual({ kind: 'take_from_holder', holder: parti });
    expect(
      decideJob({ status: 'processing', holder: parti, onBoard: true, stuckForMs: null }),
    ).toEqual({ kind: 'leave', because: 'on_board' });
  });

  it('processing : pris par cette instance et tenu par aucun de ses runs, repris une fois vu assez longtemps', () => {
    const f = { status: 'processing' as const, holder: { kind: 'self', held: false } as const };
    expect(decideJob({ ...f, onBoard: false, stuckForMs: null }).kind).toBe('leave');
    expect(decideJob({ ...f, onBoard: false, stuckForMs: vieux - 1 }).kind).toBe('leave');
    expect(decideJob({ ...f, onBoard: false, stuckForMs: vieux }).kind).toBe('take_from_holder');
  });

  it('awaiting_delegation : enfant fini → son résultat ; enfant au travail → rien ; rien à réparer → échec', () => {
    const f = { status: 'awaiting_delegation' as const, inFlightHere: false, stuckForMs: vieux };
    for (const s of ['completed', 'failed', 'cancelled']) {
      expect(decideJob({ ...f, child: { status: s } })).toEqual({ kind: 'give_child_result' });
    }
    for (const s of ['pending', 'processing', 'awaiting_delegation', 'awaiting_approval']) {
      expect(decideJob({ ...f, child: { status: s } })).toEqual({
        kind: 'leave',
        because: 'child_working',
      });
    }
    expect(decideJob({ ...f, child: null })).toEqual({
      kind: 'fail',
      reason: 'no_delegation_recorded',
    });
    expect(decideJob({ ...f, child: { status: null } })).toEqual({
      kind: 'fail',
      reason: 'child_missing',
    });
    // Ni réparé ni échoué tant que la ligne n'a pas été vue assez longtemps,
    // ni quand un run de ce processus l'exécute.
    expect(decideJob({ ...f, stuckForMs: null, child: { status: 'completed' } }).kind).toBe(
      'leave',
    );
    expect(decideJob({ ...f, inFlightHere: true, child: { status: 'completed' } }).kind).toBe(
      'leave',
    );
  });

  it('awaiting_approval : demandes toutes tranchées → reprise ; une ouverte → attente', () => {
    const f = { status: 'awaiting_approval' as const, inFlightHere: false, stuckForMs: vieux };
    expect(decideJob({ ...f, openRequests: 0, resolvedRequests: 1 })).toEqual({
      kind: 'resume_after_approval',
    });
    expect(decideJob({ ...f, openRequests: 1, resolvedRequests: 1 }).kind).toBe('leave');
    expect(decideJob({ ...f, openRequests: 0, resolvedRequests: 0 }).kind).toBe('leave');
  });

  it('pending : jamais pris et trop vieux → abandonné ; repris par le système → toujours relancé', () => {
    const f = { status: 'pending' as const, inFlightHere: false, stuckForMs: vieux };
    const tropVieux = JOB_LIVENESS.pendingAbandonMs + 1;
    expect(decideJob({ ...f, neverClaimed: true, requestAgeMs: tropVieux })).toEqual({
      kind: 'fail',
      reason: 'never_claimed',
    });
    expect(decideJob({ ...f, neverClaimed: false, requestAgeMs: 100 * tropVieux })).toEqual({
      kind: 'start',
    });
    expect(decideJob({ ...f, neverClaimed: true, requestAgeMs: 1_000 })).toEqual({
      kind: 'start',
    });
    expect(
      decideJob({ ...f, neverClaimed: true, requestAgeMs: 1_000, stuckForMs: null }).kind,
    ).toBe('leave');
    expect(
      decideJob({ ...f, inFlightHere: true, neverClaimed: true, requestAgeMs: tropVieux }).kind,
    ).toBe('leave');
  });
});

// setup-nodal-programs-host.ts — vitest setupFile du runner : dans CETTE
// suite, les programmes de Nodal (git des photos, du constat, de la sonde)
// tournent sur l'HÔTE, sauf dans les tests qui portent sur le bac à sable et le
// réactivent (`_setNodalProgramsSandboxForTests(undefined)`).
//
// Pourquoi (#628, mesuré le 16/10 sur la machine de l'owner, 24 cœurs, 64 Go) :
// la suite du runner, ce sont 215 fichiers dont chacun monte une base pglite,
// sur 24 workers en parallèle. Avec un conteneur MXC par photo, chaque worker
// tient en plus un courtier et ses conteneurs, et la mémoire engagée de la
// machine déborde — `CreateProcessW` 1455 (« commitment limit »), `VirtualAlloc
// failed` —, au hasard de 8 à 11 tests par passage. Programmes sur l'hôte :
// 213 fichiers, 2248 tests, 0 échec. En production, un seul runner, un
// conteneur par opération, fermé à la fin : rien de comparable.
//
// Le passage par le bac à sable n'en est pas moins prouvé, là où c'est le
// sujet : git-sandboxed-runner.test.ts (ici), git-sandboxed.test.ts
// (packages/tools), checkpoints-sandboxed.test.ts (apps/cli),
// deny-data-dir.test.ts et nodal-programs.test.ts (packages/sandbox), chacun
// avec sa mutation.

import { createSandbox, _setNodalProgramsSandboxForTests } from '@nodal-agents/sandbox';

_setNodalProgramsSandboxForTests(createSandbox(null));

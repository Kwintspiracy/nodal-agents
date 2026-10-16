// vc-runtime.test.ts — the VC++ runtime next to postgres.exe (0.9.7).
//
// The defect: on a Windows 10 machine whose System32 MSVCP140.dll was
// 14.24.28127.4, initdb crashed with 0xC0000005 ("performing post-bootstrap
// initialization"). Measured by hand on the real binaries: an app-local
// MSVCP140.dll 14.28 or 14.34 crashes initdb the same way, 14.40 and 14.44
// let it finish. These tests prove the mechanism on real files: the runtime
// the pack ships, PE headers written to disk, and the copy decision.

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VC_REDIST_URL,
  VC_RUNTIME_DLLS,
  VcRuntimeUnavailableError,
  compareVersion,
  ensureVcRuntime,
  readFileVersion,
  readPeImports,
  requiredVcRuntime,
  shippedVcRuntimeDir,
} from '../lib/vc-runtime.ts';
import { loadPlatformBinaries } from '../lib/embedded-postgres-binaries.ts';

const shippedDir = shippedVcRuntimeDir();

/** A minimal PE32+ file: one section holding the import table. */
function makePe(linker: [number, number], imports: string[]): Buffer {
  const buf = Buffer.alloc(0x600);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x40, 0x3c);
  buf.write('PE\0\0', 0x40, 'latin1');
  const coff = 0x44;
  buf.writeUInt16LE(0x8664, coff);
  buf.writeUInt16LE(1, coff + 2); // one section
  buf.writeUInt16LE(240, coff + 16); // optional header size
  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt); // PE32+
  buf[opt + 2] = linker[0];
  buf[opt + 3] = linker[1];
  buf.writeUInt32LE(0x1000, opt + 112 + 8); // import directory RVA
  const section = opt + 240;
  buf.writeUInt32LE(0x400, section + 8); // virtual size
  buf.writeUInt32LE(0x1000, section + 12); // virtual address
  buf.writeUInt32LE(0x400, section + 16); // raw size
  buf.writeUInt32LE(0x200, section + 20); // raw pointer
  let name = 0x200 + 20 * (imports.length + 1);
  imports.forEach((dll, i) => {
    buf.writeUInt32LE(name - 0x200 + 0x1000, 0x200 + i * 20 + 12);
    buf.write(dll + '\0', name, 'latin1');
    name += dll.length + 1;
  });
  return buf;
}

/** A file whose only content is a VS_FIXEDFILEINFO carrying `version`. */
function fileWithVersion(version: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(64);
  Buffer.from([0xbd, 0x04, 0xef, 0xfe]).copy(buf, 8);
  buf.writeUInt32LE(((version[0] << 16) | version[1]) >>> 0, 16);
  buf.writeUInt32LE(((version[2] << 16) | version[3]) >>> 0, 20);
  return buf;
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** binDir with a postgres.exe built by `linker` that imports the runtime. */
function fixture(linker: [number, number] = [14, 44]) {
  root = mkdtempSync(join(tmpdir(), 'vc-runtime-'));
  const binDir = join(root, 'bin');
  const systemDir = join(root, 'System32');
  mkdirSync(binDir);
  mkdirSync(systemDir);
  writeFileSync(join(binDir, 'postgres.exe'), makePe(linker, ['KERNEL32.dll', 'VCRUNTIME140.dll']));
  writeFileSync(
    join(binDir, 'icuuc77.dll'),
    makePe([14, 43], ['MSVCP140.dll', 'VCRUNTIME140.dll']),
  );
  writeFileSync(join(binDir, 'zlib-no-crt.dll'), makePe([14, 99], ['KERNEL32.dll']));
  return { binDir, systemDir };
}

describe('the VC++ runtime next to postgres.exe @cap:installer-et-demarrer/moteur', () => {
  it('the pack ships the three runtime DLLs, at 14.44 or newer', () => {
    for (const dll of VC_RUNTIME_DLLS) {
      const path = join(shippedDir, dll);
      expect(existsSync(path), path).toBe(true);
      const version = readFileVersion(readFileSync(path));
      expect(version, dll).not.toBeNull();
      expect(
        compareVersion(version!, [14, 44]),
        `${dll} ${version?.join('.')}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads linker version and imports from a real runtime DLL', () => {
    const info = readPeImports(readFileSync(join(shippedDir, 'msvcp140.dll')));
    expect(info).not.toBeNull();
    expect(info!.imports.map((d) => d.toLowerCase())).toContain('vcruntime140.dll');
    expect(info!.linker[0]).toBe(14);
  });

  it('the minimum is the newest linker among binaries that import the runtime', () => {
    const { binDir } = fixture([14, 44]);
    // zlib-no-crt.dll (14.99) imports no runtime: it does not count.
    expect(requiredVcRuntime(binDir)).toEqual([14, 44]);
  });

  it('copies the shipped runtime next to postgres.exe, then leaves it alone', () => {
    const { binDir, systemDir } = fixture();

    const first = ensureVcRuntime({ binDir, shippedDir, systemDir });
    expect(first).toMatchObject({ kind: 'app-local', copied: [...VC_RUNTIME_DLLS] });
    for (const dll of VC_RUNTIME_DLLS)
      expect(sha(join(binDir, dll))).toBe(sha(join(shippedDir, dll)));

    const second = ensureVcRuntime({ binDir, shippedDir, systemDir });
    expect(second).toMatchObject({ kind: 'app-local', copied: [] });
  });

  it('replaces an older runtime next to postgres.exe, keeps a newer one', () => {
    const { binDir, systemDir } = fixture();
    cpSync(shippedDir, binDir, { recursive: true });
    writeFileSync(join(binDir, 'msvcp140.dll'), fileWithVersion([14, 24, 28127, 4]));
    writeFileSync(join(binDir, 'vcruntime140_1.dll'), fileWithVersion([14, 99, 0, 0]));

    const out = ensureVcRuntime({ binDir, shippedDir, systemDir });

    expect(out).toMatchObject({ kind: 'app-local', copied: ['msvcp140.dll'] });
    expect(sha(join(binDir, 'msvcp140.dll'))).toBe(sha(join(shippedDir, 'msvcp140.dll')));
    expect(readFileVersion(readFileSync(join(binDir, 'vcruntime140_1.dll')))).toEqual([
      14, 99, 0, 0,
    ]);
  });

  it('when no copy can be made, refuses with a coded error if System32 is too old', () => {
    const { binDir, systemDir } = fixture();
    writeFileSync(join(systemDir, 'msvcp140.dll'), fileWithVersion([14, 24, 28127, 4]));
    const denied = () => {
      throw new Error("EPERM: operation not permitted, copyfile 'msvcp140.dll'");
    };

    let caught: unknown;
    try {
      ensureVcRuntime({ binDir, shippedDir, systemDir, copyFile: denied });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VcRuntimeUnavailableError);
    const err = caught as VcRuntimeUnavailableError;
    expect(err.reason).toBe('VC_RUNTIME_OUTDATED');
    expect(err.message).toContain('14.44 or newer');
    expect(err.message).toContain('This machine has 14.24.28127.4');
    expect(err.message).toContain('EPERM');
    expect(err.message).toContain(VC_REDIST_URL);
  });

  it('when no copy can be made, uses System32 if it is new enough', () => {
    const { binDir, systemDir } = fixture();
    writeFileSync(join(systemDir, 'msvcp140.dll'), fileWithVersion([14, 50, 35719, 0]));
    const denied = () => {
      throw new Error('EPERM');
    };

    expect(ensureVcRuntime({ binDir, shippedDir, systemDir, copyFile: denied })).toEqual({
      kind: 'system',
      version: [14, 50, 35719, 0],
      copyError: 'EPERM',
    });
  });

  it('refuses a pack whose runtime is older than the binaries need', () => {
    const { binDir, systemDir } = fixture([14, 60]);
    expect(() => ensureVcRuntime({ binDir, shippedDir, systemDir })).toThrow(
      expect.objectContaining({ reason: 'VC_RUNTIME_SHIPPED_TOO_OLD' }),
    );
  });

  it('refuses a pack that does not carry the runtime', () => {
    const { binDir, systemDir } = fixture();
    expect(() =>
      ensureVcRuntime({ binDir, shippedDir: join(binDir, 'nowhere'), systemDir }),
    ).toThrow(expect.objectContaining({ reason: 'VC_RUNTIME_NOT_SHIPPED' }));
  });

  // The binaries only exist where npm installed the Windows package, so this
  // case runs on Windows (the Windows CI and a Windows dev machine) only.
  it.runIf(process.platform === 'win32')(
    'the shipped runtime covers the real embedded Postgres binaries',
    async () => {
      const binaries = await loadPlatformBinaries();
      expect(binaries, 'the Windows Postgres package is not installed').not.toBeNull();
      const binDir = join(binaries!.postgres, '..');
      const required = requiredVcRuntime(binDir);
      expect(required).not.toBeNull();
      const shipped = readFileVersion(readFileSync(join(shippedDir, 'msvcp140.dll')))!;
      expect(compareVersion(shipped, required!)).toBeGreaterThanOrEqual(0);
    },
  );

  // Authenticode can only be verified by Windows itself.
  it.runIf(process.platform === 'win32')(
    'each shipped DLL carries a valid Microsoft Authenticode signature',
    () => {
      // Un seul processus PowerShell pour toutes les DLL : le démarrage à froid d'un runner CI coûte cher.
      const script = VC_RUNTIME_DLLS.map(
        (dll) =>
          `$s = Get-AuthenticodeSignature -LiteralPath '${join(shippedDir, dll)}'; ` +
          `"${dll}|$($s.Status)|$($s.SignerCertificate.Subject)"`,
      ).join('; ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf-8',
      });
      const lines = new Map<string, { status: string; subject: string }>();
      for (const line of out.split(/\r?\n/)) {
        const [name, status, ...rest] = line.trim().split('|');
        if (name && status !== undefined) lines.set(name, { status, subject: rest.join('|') });
      }
      for (const dll of VC_RUNTIME_DLLS) {
        const sig = lines.get(dll);
        expect(sig, `no signature line for ${dll}`).toBeDefined();
        expect(sig!.status, dll).toBe('Valid');
        expect(sig!.subject, dll).toContain('O=Microsoft Corporation');
      }
    },
    // Lancement de PowerShell à froid sur un runner CI : bien plus que les 5 s par défaut.
    60_000,
  );
});

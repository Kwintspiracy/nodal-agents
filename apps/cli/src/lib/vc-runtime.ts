// vc-runtime.ts — the Visual C++ runtime the embedded Postgres needs on Windows
// sits next to postgres.exe, so that the user installs nothing (0.9.7).
//
// 16/10/2026, on a Windows 10 machine (19044, x64): `nodal-agents up` failed in
// initdb's "performing post-bootstrap initialization" with exception
// 0xC0000005, faulting module C:\WINDOWS\SYSTEM32\MSVCP140.dll 14.24.28127.4.
// The binaries of @embedded-postgres/windows-x64@18.3.0-beta.17 are built with
// MSVC toolsets 14.40 to 14.44 (the PE linker version), and ICU (icuuc77.dll…)
// imports MSVCP140.dll. Microsoft's rule is that the runtime must be at least as
// new as the newest toolset that built the binaries. Measured here, initdb with
// an app-local MSVCP140.dll of each version: 14.28 and 14.34 crash with
// 0xC0000005, 14.40 and 14.44 succeed. An app-local copy wins over System32,
// which is what this file relies on: Windows searches the executable's own
// directory before System32 for a DLL that is not a KnownDLL, and the VC++
// runtime is not one.
//
// So on every boot, before Postgres starts, the three runtime DLLs the pack
// carries (vc-runtime/x64, Microsoft's redistributable files, allowed for
// app-local deployment) are copied next to postgres.exe when they are missing
// or older there. Idempotent: an up-to-date copy is left alone, a newer one too.
//
// When the copy cannot be made (an install directory the user cannot write),
// System32's runtime is read instead. If it is new enough, Postgres starts on
// it; if not, `up` refuses with a coded error and the redistributable's link.
// The minimum is not a constant: it is read from the Postgres binaries
// themselves, so a later @embedded-postgres build moves it with no code change.

import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The runtime DLLs the Postgres binaries import, and that the pack carries. */
export const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'] as const;

/** Microsoft's permalink to the current x64 redistributable. */
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

const VC_IMPORT = /^(msvcp140|vcruntime140)/i;
const VC_RUNTIME_NAMES = new Set<string>(VC_RUNTIME_DLLS);

export type Version = readonly number[];

/** Negative when a < b. Missing trailing parts count as 0. */
export function compareVersion(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const formatVersion = (v: Version): string => v.join('.');

/** Linker version and imported DLL names of a PE file, or null if it is not one. */
export function readPeImports(buf: Buffer): { linker: Version; imports: string[] } | null {
  if (buf.length < 0x40 || buf.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
  const coff = pe + 4;
  const sectionCount = buf.readUInt16LE(coff + 2);
  const optionalSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const pe32plus = buf.readUInt16LE(opt) === 0x20b;
  const linker = [buf[opt + 2]!, buf[opt + 3]!];
  const importRva = buf.readUInt32LE(opt + (pe32plus ? 112 : 96) + 8);
  const sections: { va: number; size: number; raw: number }[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = opt + optionalSize + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const offset = (rva: number): number => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    return s ? rva - s.va + s.raw : -1;
  };
  const imports: string[] = [];
  for (let p = importRva ? offset(importRva) : -1; p > 0 && p + 20 <= buf.length; p += 20) {
    const nameRva = buf.readUInt32LE(p + 12);
    if (!nameRva) break;
    const start = offset(nameRva);
    if (start < 0) break;
    const end = buf.indexOf(0, start);
    imports.push(buf.toString('latin1', start, end));
  }
  return { linker, imports };
}

/** The file version of a PE file (VS_FIXEDFILEINFO), or null when it has none. */
export function readFileVersion(buf: Buffer): Version | null {
  // VS_FIXEDFILEINFO starts with the signature 0xFEEF04BD, then the struct
  // version, then dwFileVersionMS / dwFileVersionLS.
  const at = buf.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
  if (at < 0 || at + 16 > buf.length) return null;
  const ms = buf.readUInt32LE(at + 8);
  const ls = buf.readUInt32LE(at + 12);
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
}

/**
 * The runtime version the binaries in `binDir` need: the newest linker version
 * among those that import the VC++ runtime. Null when none imports it.
 */
export function requiredVcRuntime(binDir: string): Version | null {
  let required: Version | null = null;
  for (const name of readdirSync(binDir)) {
    if (!/\.(exe|dll)$/i.test(name) || VC_RUNTIME_NAMES.has(name.toLowerCase())) {
      continue;
    }
    const info = readPeImports(readFileSync(join(binDir, name)));
    if (!info || !info.imports.some((d) => VC_IMPORT.test(d))) continue;
    if (required === null || compareVersion(info.linker, required) > 0) required = info.linker;
  }
  return required;
}

export type VcRuntimeFault =
  /** The pack does not carry the runtime files: a broken build. */
  | 'VC_RUNTIME_NOT_SHIPPED'
  /** The runtime the pack carries is older than the binaries need: a broken build. */
  | 'VC_RUNTIME_SHIPPED_TOO_OLD'
  /** No copy could be made, and System32's runtime is missing or too old. */
  | 'VC_RUNTIME_OUTDATED';

export class VcRuntimeUnavailableError extends Error {
  readonly reason: VcRuntimeFault;
  constructor(reason: VcRuntimeFault, message: string) {
    super(`${reason}: ${message}`);
    this.name = 'VcRuntimeUnavailableError';
    this.reason = reason;
  }
}

export type VcRuntimeOutcome =
  /** Every DLL next to postgres.exe is at least the shipped version. */
  | { readonly kind: 'app-local'; readonly copied: readonly string[]; readonly version: Version }
  /** The copy failed; System32's runtime is new enough and is the one used. */
  | {
      readonly kind: 'system';
      readonly version: Version;
      readonly copyError: string;
    };

export interface EnsureVcRuntimeOptions {
  /** The directory holding postgres.exe. */
  readonly binDir: string;
  /** The directory holding the shipped runtime DLLs. */
  readonly shippedDir: string;
  /** Where Windows keeps the system runtime (System32). */
  readonly systemDir: string;
  /** Injected for the tests; defaults to fs.copyFileSync. */
  readonly copyFile?: (from: string, to: string) => void;
}

function versionOf(path: string): Version | null {
  return existsSync(path) ? readFileVersion(readFileSync(path)) : null;
}

/** Put the shipped runtime next to postgres.exe, or prove System32's is enough. */
export function ensureVcRuntime(opts: EnsureVcRuntimeOptions): VcRuntimeOutcome {
  const copyFile = opts.copyFile ?? copyFileSync;
  const missing = VC_RUNTIME_DLLS.filter((d) => !existsSync(join(opts.shippedDir, d)));
  if (missing.length > 0) {
    throw new VcRuntimeUnavailableError(
      'VC_RUNTIME_NOT_SHIPPED',
      `This install of Nodal-Agents is incomplete: ${missing.join(', ')} missing from ` +
        `${opts.shippedDir}. Reinstall it: npm install -g nodal-agents@latest`,
    );
  }
  const shipped = versionOf(join(opts.shippedDir, 'msvcp140.dll'));
  const required = requiredVcRuntime(opts.binDir);
  if (shipped === null || (required !== null && compareVersion(shipped, required) < 0)) {
    throw new VcRuntimeUnavailableError(
      'VC_RUNTIME_SHIPPED_TOO_OLD',
      `The Visual C++ runtime this install carries (${shipped ? formatVersion(shipped) : 'unreadable'}) ` +
        `is older than the ${formatVersion(required ?? [])} the database binaries need. ` +
        `Reinstall Nodal-Agents: npm install -g nodal-agents@latest`,
    );
  }

  const copied: string[] = [];
  try {
    for (const dll of VC_RUNTIME_DLLS) {
      const from = join(opts.shippedDir, dll);
      const to = join(opts.binDir, dll);
      const present = versionOf(to);
      const ours = versionOf(from) ?? shipped;
      if (present !== null && compareVersion(present, ours) >= 0) continue;
      copyFile(from, to);
      copied.push(dll);
    }
    return { kind: 'app-local', copied, version: shipped };
  } catch (err) {
    const copyError = err instanceof Error ? err.message : String(err);
    const system = versionOf(join(opts.systemDir, 'msvcp140.dll'));
    const floor = required ?? shipped;
    if (system !== null && compareVersion(system, floor) >= 0) {
      return { kind: 'system', version: system, copyError };
    }
    throw new VcRuntimeUnavailableError(
      'VC_RUNTIME_OUTDATED',
      `The database needs the Microsoft Visual C++ runtime ${formatVersion(floor)} or newer. ` +
        `This machine has ${system ? formatVersion(system) : 'none'}, and Nodal could not place ` +
        `its own copy next to the database (${copyError}). Install the runtime from ` +
        `${VC_REDIST_URL}, then run nodal-agents up again.`,
    );
  }
}

/**
 * The shipped runtime directory, for the layout this build runs in: a sibling
 * of cli.js in the pack, `apps/cli/vc-runtime/x64` in the monorepo.
 */
export function shippedVcRuntimeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'vc-runtime', 'x64');
  return existsSync(sibling) ? sibling : join(here, '..', '..', 'vc-runtime', 'x64');
}

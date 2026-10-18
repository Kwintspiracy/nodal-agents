# Visual C++ runtime for the embedded Postgres on Windows

These are **Microsoft's redistributable Visual C++ runtime files, shipped
app-locally**. `nodal-agents up` copies them next to `postgres.exe` on Windows
(`apps/cli/src/lib/vc-runtime.ts`). The binaries of
`@embedded-postgres/windows-x64@18.3.0-beta.17` are built with MSVC toolsets
14.40 to 14.44, and on a machine whose System32 runtime is older, initdb
crashes with `0xC0000005` in `MSVCP140.dll` (measured on 16/10/2026: an
app-local 14.28 or 14.34 crashes, 14.40 and 14.44 work).

## Source, pinned

| | |
|---|---|
| Package | `Microsoft.VC.14.44.17.14.CRT.Redist.X64.base`, version 14.44.35211 |
| Listed in | Visual Studio 2022 release channel (`https://aka.ms/vs/17/release/channel` → `VisualStudio.vsman`, product 17.14.42, read 16/10/2026) |
| URL | `https://download.visualstudio.microsoft.com/download/pr/45d3b8dd-bced-4b37-9974-142f748d710c/4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5/Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix` |
| Package SHA-256 | `4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5` (as the manifest gives it) |
| Folder inside | `Contents/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT/` |

| File | Version | SHA-256 |
|---|---|---|
| `x64/msvcp140.dll` | 14.44.35211.0 | `0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9` |
| `x64/vcruntime140.dll` | 14.44.35211.0 | `d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066` |
| `x64/vcruntime140_1.dll` | 14.44.35211.0 | `1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f` |

Authenticode: each file `Valid`, signed by
`CN=Microsoft Windows, O=Microsoft Corporation`.

## Reproducing the bytes

```bash
node scripts/fetch-vc-runtime.mjs --check   # downloads, verifies every hash, compares
node scripts/fetch-vc-runtime.mjs           # writes the three files here
```

The pins live in `scripts/lib/vc-runtime-source.mjs`; this table repeats them.
The files are committed, so building the pack and running the dev stack need
no network. `scripts/tests/vc-runtime-source.test.mjs` refuses committed files
whose hashes differ from the pins; `apps/cli/src/tests/vc-runtime.test.ts`
checks the version (14.44 or newer) and, on Windows, the Authenticode
signature and the real Postgres binaries' minimum.

## Updating them

Pick a newer `Microsoft.VC.<ver>.CRT.Redist.X64.base` package from the channel
manifest, update the pins (package URL and SHA-256, folder, three file
hashes), run the script, and update this file.

# nodal-agents-sandbox-windows

Windows-only carrier of [Microsoft MXC](https://www.npmjs.com/package/@microsoft/mxc-sdk)
for the Nodal-Agents OS sandbox (issue #628).

`nodal-agents` takes this package as an **optional dependency**. Its only job is
to pull `@microsoft/mxc-sdk` (pinned exact `1.0.0`), and its `"os": ["win32"]`
field makes npm **skip it on every non-Windows platform**. So:

- **Windows:** the package installs, `@microsoft/mxc-sdk` is hoisted into the
  install's `node_modules`, and the runner's `import("@microsoft/mxc-sdk/v1")`
  resolves it. The sandbox is available.
- **Linux / macOS:** npm skips this package (os mismatch), so neither
  `@microsoft/mxc-sdk` nor its native dependency `node-pty` is ever fetched or
  compiled. The runner's `import()` fails and the sandbox reports
  `SANDBOX_BACKEND_MISSING` at boot — no `node-gyp` build, no C toolchain
  needed, no install failure.

This indirection replaces declaring `@microsoft/mxc-sdk` as a direct optional
dependency of `nodal-agents`: as a direct optional dep, npm still **tried** to
install it on Linux (fetching `node-pty`, attempting a native build, then
dropping it), which was slow and noisy. The `"os"` gate on this wrapper stops
the fetch before it starts.

## Why a separate published package

`"os"` only skips a package when it is a *dependency*; it does nothing for a
package declared inline. A dedicated published package is the one mechanism npm
honours to keep a dependency subtree off the wrong platform.

## Publishing (Quentin's gesture)

This package is published by hand, from this directory, **only when the MXC SDK
version it pins changes**. It has no build step.

```sh
cd packaging/sandbox-windows
# 1. Confirm the pinned SDK version matches what the pack expects:
#    build-pack.mjs → optionalDependencies["nodal-agents-sandbox-windows"]
npm publish --access public
```

The version here and the version `nodal-agents` pins in `build-pack.mjs` move
together. Bump both when `@microsoft/mxc-sdk` is upgraded.

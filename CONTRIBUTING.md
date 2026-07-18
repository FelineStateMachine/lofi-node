# Contributing to lofi-node

## Prerequisites

- Deno 2.9+ (the only global runtime requirement for the TS side)
- Rust stable (only when touching `native/iroh-js/`; `deno task native` builds the addon)

## The gate

```sh
deno task check && deno task test
```

`check` runs fmt --check, lint, and typecheck. `test` runs the full fixture suite; iroh/jazz
integration tests auto-skip (with a visible marker) when the native addon isn't built, so the fast
path never needs Rust.

## Branches & PRs

Prefix branches by intent (`fix/`, `feat/`, `docs/`, `chore/`), keep a PR to one concern, and state
the evidence for behavior claims (test name or command output) in the description.

## Hard boundaries

- **Vendoring contract**: everything under `native/iroh-js/` except `src/lofi_ext.rs` is upstream
  code. Never edit vendored files beyond `// lofi-node:` marked lines; follow the update procedure
  in `native/iroh-js/UPSTREAM.md`. `deno fmt`/`lint` exclude the directory — keep it that way.
- **Version pins are decisions**: `jazz-tools`/`jazz-napi` are pinned to the exact alpha the lofi
  framework pins. Bumps are coordinated changes with the full suite as evidence, never drive-by.
- **No silent degradation**: a missing capability (native addon, platform) must surface as a typed
  reason in `status()`, never as quietly reduced behavior.
- **Secrets**: nothing under `lofi-node-data/`, `data/`, or generated `config.json` files may be
  committed; test secrets are obviously-fake fixed strings.
- **Never call the upstream watch APIs** from the TS layer — at iroh-ffi v1.1.0 they abort the
  process under Deno (see UPSTREAM.md known issues).

## Releasing

Published to JSR as `@nzip/lofi-node`. The package ships TypeScript only; native addons are
GitHub-release assets that the loader downloads and sha256-verifies against digests committed in
`src/native/artifacts.ts` (regenerate with `deno task release:artifacts` — CI fails if stale).

Procedure (tags on `main`, no dev branch):

1. Bump `version` in `deno.json`; run `deno task release:artifacts`.
2. `deno task check && deno task test`, then inspect the artifact: `deno task publish:dry`.
3. Commit, push, wait for ci green.
4. `git tag v<version> && git push origin v<version>` — publish.yml verifies the tag matches
   `deno.json`, publishes to JSR via OIDC, compiles the three target binaries, and creates the
   GitHub release with binaries + raw addon assets + `SHA256SUMS`, then smokes the fresh publish
   from the registry.
5. JSR versions are immutable — mistakes fix forward as the next patch version.

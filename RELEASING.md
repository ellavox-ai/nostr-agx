# Releasing

The packages publish to the public `@nostr-agx` npm scope. Core, nostr and the Tailscale
integration are built with `tsup` as ESM + CJS + `.d.ts`, the CLI as one ESM bundle, and the n8n
nodes as one CommonJS file per node (n8n `require`s them); the gateway n8n nodes are plain `tsc`
output, with nothing bundled. Release them together at the same version.

Releases are published by GitHub Actions ([`publish.yml`](.github/workflows/publish.yml)) with npm
provenance, which n8n requires of community nodes and which records the commit each package was
built from.

1. Bump `version` in `packages/core`, `packages/nostr`, `packages/tailscale`, `packages/cli`,
   `packages/n8n-nodes-agx` and `packages/n8n-nodes-agx-gateway` `package.json`, plus
   `AGX_CORE_VERSION` (`packages/core/src/index.ts`), `AGX_NOSTR_VERSION`
   (`packages/nostr/src/index.ts`) and `AGX_CLI_VERSION` (`packages/cli/src/lib/version.ts`; `version.test.ts` fails if it
   drifts from `packages/cli/package.json`), and the gateway container's `AGX_PACKAGE` in
   `deploy/gateway/Dockerfile` and image tag in `deploy/gateway/compose.yaml` (the same test checks
   both).
2. Build, test and check what each tarball ships:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build && pnpm type-check && pnpm test
   pnpm check:packages
   node scripts/publish-packages.mjs v<version> --dry-run
   ```

   The Tailscale package ships prebuilt launcher binaries in `packages/tailscale/bin/`. If the Go
   source in `packages/tailscale/launcher/` changed, refresh them with
   `pnpm --filter @nostr-agx/tailscale build:launcher` (Go 1.27+) and commit the result.

3. Merge to `main`, then tag that commit and push the tag:

   ```sh
   git tag v<version> && git push origin v<version>
   ```

   The workflow refuses a tag whose commit is not on `main`, then builds, tests and checks again,
   and publishes in dependency order (core, nostr, Tailscale integration, CLI, n8n nodes) with
   [`scripts/publish-packages.mjs`](scripts/publish-packages.mjs). It refuses a tag that does not
   match every package's version, and skips a version already on npm, so a run that failed
   part-way can be re-run.

## npm setup (once per package)

The workflow authenticates with npm Trusted Publishing, so no token is stored in the repository.
On npmjs.com, open each package's **Settings → Trusted Publisher**, choose GitHub Actions, and
enter the repository `ellavox-ai/nostr-agx` and the workflow `publish.yml`.

npm only lets you add a trusted publisher to a package that already exists. For a package's first release
(`@nostr-agx/tailscale`, `@nostr-agx/n8n-nodes-agx` and `@nostr-agx/n8n-nodes-agx-gateway` have none yet), add a granular npm access token with publish rights to
the scope as the repository secret `NPM_TOKEN`; the workflow uses it while it is set, still with
provenance. Configure the trusted publisher afterwards and delete the secret.

Publishing by hand is a fallback only: use `pnpm publish`, not `npm publish` (only pnpm rewrites
the `workspace:*` dependencies), and know that a hand-published version has no provenance — n8n
will not accept it for the n8n nodes.

A published version can never be changed or reused, including its description and README; any
change to what npm shows needs a new version.

# Releasing

The packages publish to the public `@nostr-agx` npm scope, built with `tsup`: core and nostr as
ESM + CJS + `.d.ts`, the CLI as one ESM bundle, and the n8n nodes as one CommonJS file per node
(n8n `require`s them). Release them together at the same version.

Releases are published by GitHub Actions ([`publish.yml`](.github/workflows/publish.yml)) with npm
provenance, which n8n requires of community nodes and which records the commit each package was
built from.

1. Bump `version` in `packages/core`, `packages/nostr`, `packages/cli` and `packages/n8n-nodes-agx`
   `package.json`, plus
   `AGX_CORE_VERSION` (`packages/core/src/index.ts`), `AGX_NOSTR_VERSION`
   (`packages/nostr/src/index.ts`) and `AGX_CLI_VERSION` (`packages/cli/src/lib/version.ts`; `version.test.ts` fails if it
   drifts from `packages/cli/package.json`).
2. Build, test and check what each tarball ships:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build && pnpm type-check && pnpm test
   pnpm check:packages
   node scripts/publish-packages.mjs v<version> --dry-run
   ```

3. Merge to `main`, then tag that commit and push the tag:

   ```sh
   git tag v<version> && git push origin v<version>
   ```

   The workflow builds, tests and checks again, then publishes in dependency order with
   [`scripts/publish-packages.mjs`](scripts/publish-packages.mjs). It refuses a tag that does not
   match every package's version, and skips a version already on npm, so a run that failed
   part-way can be re-run.

## npm setup (once per package)

The workflow authenticates with npm Trusted Publishing, so no token is stored in the repository.
On npmjs.com, open each package's **Settings → Trusted Publisher**, choose GitHub Actions, and
enter the repository `ellavox-ai/nostr-agx` and the workflow `publish.yml`.

npm only lets you add a trusted publisher to a package that already exists. For a package's first release
(`@nostr-agx/n8n-nodes-agx` has none yet), add a granular npm access token with publish rights to
the scope as the repository secret `NPM_TOKEN`; the workflow uses it while it is set, still with
provenance. Configure the trusted publisher afterwards and delete the secret.

Publishing by hand is a fallback only: use `pnpm publish`, not `npm publish` (only pnpm rewrites
the `workspace:*` dependencies), and know that a hand-published version has no provenance — n8n
will not accept it for the n8n nodes.

A published version can never be changed or reused, including its description and README; any
change to what npm shows needs a new version.

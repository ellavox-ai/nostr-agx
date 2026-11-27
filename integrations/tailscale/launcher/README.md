# Bundled `agx-tailscale` launcher

Go source for the native child process started by `src/launcher.ts`. It joins a tailnet with
`tsnet`, opens a loopback-only SOCKS5 proxy, prints its URL on stdout, and exits when stdin closes.

The prebuilt binaries in `../bin/<platform>/` are produced from this source:

```sh
# from the package root (requires Go 1.27.4 or later, the version in go.mod)
pnpm build:launcher
```

`make -C launcher build-all` cross-compiles to `launcher/dist/<platform>/`, then
`scripts/stage-binaries.mjs` copies those files into `../bin/`. Those binaries are generated and
are not checked in; stage them locally when testing. The CI workflow and the release workflow
([`publish.yml`](../../../.github/workflows/publish.yml)) run the same staging step before they test and pack, so a
published package carries the binaries.

Run the Go tests with `make -C launcher test`.

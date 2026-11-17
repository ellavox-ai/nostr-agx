# Bundled `agx-tailscale` launcher

Go source for the native child process started by `src/launcher.ts`. It joins a tailnet with
`tsnet`, opens a loopback-only SOCKS5 proxy, prints its URL on stdout, and exits when stdin closes.

The prebuilt binaries in `../bin/<platform>/` are produced from this source:

```sh
# from packages/tailscale (requires Go 1.27+)
pnpm build:launcher
```

`make -C launcher build-all` cross-compiles to `launcher/dist/<platform>/`, then
`scripts/stage-binaries.mjs` copies those files into `../bin/`. Commit the staged binaries — they
are what the published npm package ships.

Run the Go tests with `make -C launcher test`.

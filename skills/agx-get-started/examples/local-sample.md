# Default path: run the sample task

The fixture starts two small programs on your computer: a requester asks for fictional order `DEMO-1001`, and a receiver returns a preset status through AGX. Neither is an AI agent. It starts a loopback relay, creates temporary requester/receiver identities, allows only that requester, and calls `demo.order-status`. It verifies the returned result and cleans up. No personal AGX profile, public relay, desktop plugin or n8n is used. To connect two AI agents instead, use [the next-step guide](../START-HERE.md#next-connect-two-ai-agents); this local demo is optional.

## Run it

Use Node **22.12+** and npm; Node **24.13.0** was tested. If missing, install a compatible version from [nodejs.org](https://nodejs.org/en/download), reopen the terminal, and check `node --version` and `npm --version`.

Open the [fixture folder](local-receiver/package.json) in a terminal. An assistant should give its resolved absolute path for the directory-change command. Then:

```sh
npm ci --ignore-scripts --no-audit --no-fund &&
npm run sample
```

The first command downloads dependencies into this folder using its lockfile. It installs nothing globally and skips dependency lifecycle scripts. The `&&` prevents running the sample after a failed install. If matching dependencies are already installed, use only `npm run sample`. When handing over the directory change too, quote the resolved absolute path and join it to this block with `&&`; a failed folder change must stop the sequence.

The script selects a free loopback port, so an existing relay on port 7447 is not a conflict. It clears inherited `AGX_*` overrides, uses a fresh temporary `AGX_HOME`, and never reads or replaces personal agent keys. It accepts no arguments for real identities or peers.

## Expected result

The report includes temporary public addresses, the loopback URL, CLI version, `completed: true`, `cleanedUp: true`, and:

```json
{
  "source": "agx-get-started-demo",
  "demo": true,
  "orderId": "DEMO-1001",
  "found": true,
  "status": "ready-for-pickup",
  "nextStep": "Collect at the fictional demo warehouse."
}
```

This is an actual signed/encrypted AGX task round trip using published CLI 0.3.0 and a deterministic receiver. It is not AI reasoning or access to a live order system. Success is checked against the real result, not just relay acceptance.

## Recovery

1. **Missing runtime/dependencies:** fix Node/npm first. For a missing local CLI or failed download, rerun the dependency command. For a lockfile mismatch, restore the reviewed `package.json` and `package-lock.json` together; do not guess a newer package version.
2. **Relay cannot bind loopback:** a shell sandbox may forbid listening. Run in your own terminal or use the host's permitted loopback-access approval. Do not switch to a public relay or stop another person's relay.
3. **Receiver startup fails:** use its printed error and check this fixture's files/dependencies. Do not change a personal allowlist or kill another AGX session.
4. **Task timeout:** check receiver startup, generated requester authorization, exact capability and the printed shared relay. The wrapper supplies these automatically; retain its error if it still fails. Timeout alone does not establish rejection.
5. **After correcting the cause:** rerun `npm run sample` once. This is appropriate for the synthetic read-only lookup. For other capabilities, establish whether work ran before retrying: timeout does not cancel queued work.

Normal exit and Ctrl-C request cleanup. Forcibly killing the parent or closing its terminal may prevent cleanup; this is a disposable demo, not a service manager. On normal completion the receiver/relay are stopped and keys removed. Rerunning creates a new isolated exchange; it does not resume a persistent identity.

## Reviewer verification

```sh
npm test
```

Tests perform real CLI requests, validate output, confirm an unapproved requester never executes the handler, check normal receiver restart and fresh work, demonstrate timeout/recovery, and check cleanup after interruption. In particular, queued work can execute after a timed-out requester has stopped waiting. No exactly-once guarantee is claimed.

Inspect the [receiver](local-receiver/handler.mjs), [lookup](local-receiver/order-status.mjs), [runner](local-receiver/run-sample.mjs), and [tests](local-receiver/test-sample.mjs). Installed dependencies are ignored by the fixture's `.gitignore`.

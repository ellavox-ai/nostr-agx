# Optional: Claude Code or standalone Codex requests a task from remote Hermes

Use this path when the user chooses a real Hermes peer. The shared skill's local sample remains the default and is not a prerequisite. This example sends one fixed fictional paragraph to `hermes.summarize`, obtains a real model-generated summary, and checks receiver disconnection. It does not enable general shell, file retrieval or other agent capabilities.

The original revision-2 flow was tested with Claude Code 2.1.285 on macOS, Node 24.13.0, published AGX CLI 0.3.0, and Hermes Agent v0.21.5 on a Linux VPS. The direct Claude request, clean summary and automatic test-group cleanup were reported successful. That run's fresh READY did not explicitly reconfirm private context; this guide now requires that confirmation. The shared PR candidate subsequently added review-digest binding, public-key checksum checks, receiver overlap protection, supervised client commands and output-failure cleanup. A later Codex-to-Hermes readiness check correctly stopped before starting: inherited gateway settings could override the temporary workspace. The handler now removes the child gateway marker and pins its workspace environment. The corrected revision-4 runtime subsequently completed a real standalone Codex desktop exchange on October 17, 2026 (Chicago), using CLI 0.3.0 and Node 24.13.0 against Hermes `v0.21.5+4911.g6ec0520.dirty`. Codex directly observed one digest-bound request return a clean verified summary. The operator supplied complete fresh READY, including a no-model effective-directory check after configuration loading, and confirmed matching automatic shutdown with no live test group. This establishes that scoped Codex path; it does not retroactively verify the earlier Claude privacy report or test Claude on revision 4.

## Scope and host controls

The kit installs CLI 0.3.0 locally with its lockfile; no global `agx` or marketplace plugin is needed for this example. Node 22.12+ and npm are required. The standalone requester is the actual Claude Code command tool or Codex desktop normal command tool. Claude.ai, Cowork and ordinary ChatGPT requester surfaces were not tested. An installed AGX draft-only guard still applies: do not change send modes, disable hooks, use another tool to evade a denial, or present normal Bash approval as an exception to that guard.

If an Elladex AGX plugin is installed, follow the matching host adapter and its supported CLI/send controls instead of assuming this helper is compatible. Both standalone paths were tested without an AGX marketplace plugin. Codex plugin requests remain user-terminal-only; even Claude's `claude-sends` does not authorize arbitrary helper-based key/trust operations or protected-file access.

The included `peer.mjs` deliberately uses **`wss://nos.lol`** because the peers are on different machines. Explain and obtain the user's choice of this public route before setup; reuse authorization already given for it. Contents are encrypted by AGX, but the relay can observe connecting IPs, recipient test public keys and traffic metadata. The existing Hermes provider receives the synthetic prompt. This is not an OS sandbox or a guarantee about the machine's existing SSH service.

For a user-selected private relay, preserve that choice and adapt/review the route separately; do not silently substitute this public demo. `peer.mjs` clears inherited `AGX_*` overrides, so setting a different relay in the environment does not reconfigure this kit.

## Prepare the two isolated kits

An assistant must resolve this example's absolute directory from the skill's location, and substitute actual paths/public addresses in user handoffs. Uppercase address tokens below describe arguments; do not send unresolved tokens as commands. Distinguish commands for a normal terminal from instructions pasted into a Claude/Hermes conversation.

On the Mac, from this example directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node peer.mjs init requester
```

Reuse matching installed dependencies. The command reuses or creates only this folder's `.agx-test` requester and prints its public npub. Do not import, export or replace normal agent keys or switch a global active profile. Read public identities through the CLI, not `identity.json` contents.

Give the receiver operator a clean copy of only these files:

```text
SETUP.md
.gitignore
package.json
package-lock.json
peer.mjs
request-plan.mjs
receiver-lock.mjs
supervise.mjs
hermes-handler.mjs
bridge.test.mjs
supervisor.test.mjs
peer.test.mjs
exchange.test.mjs
```

An assistant may package that explicit allowlist for a user-selected transfer channel. Inspect archive member paths before extraction; exclude `.agx-test`, `node_modules`, `request-plan.json`, credentials and private configuration. Never archive the whole working folder after initializing it. For an update, replace only listed public files in the existing isolated kit, preserving the receiver identity and dependencies. Use the actual uploaded archive name, not the name of an older ZIP. If it is absent, check that exact path and ask for the missing upload; do not list or search unrelated home-directory contents. SSH password entry belongs in the user's own terminal, not chat.

On the receiver, use Node 22.12+ and the same local dependency command if needed. For a fresh receiver, run `node peer.mjs init receiver`; for an update, retain and inspect the existing public identity through the CLI. The remote operator can run `npm test` and `npm run test:exchange` (two loopback-only exchanges with a simulated model). Those tests create and stop their own temporary groups; they require process inspection and, for exchange tests, a loopback listener. They do not contact a public relay or real model provider. Use normal host approvals without adding permanent blanket permissions.

## Readiness before any model task

The receiver operator must check the **actual installed version and effective configuration for the new test turn**, not just read the handler's prompt. Report results and presence/absence without printing configuration values, credentials, environment dumps or private memory. Preserve normal provider authentication and the normal Hermes gateway.

Require all of these checks for this synthetic demo:

- **Tools:** after plugin discovery, the handler's exact `--toolsets ' '` selection resolves to zero effective tool definitions, including plugin/MCP tools. On tested Hermes v0.21.5 the whitespace string selects an explicit empty set and prints a blank-toolset warning. This is version-dependent; removing the flag or passing an empty string may enable defaults. Stop if zero tools cannot be established; do not add `--yolo` or default tools.
- **Rules/context files:** `--ignore-rules` actually prevents AGENTS.md, SOUL.md, `.cursorrules` and other file-context loading for this turn.
- **Memory:** both built-in memory and external memory-provider loading/injection are disabled for this turn. Zero tools alone does not prove this.
- **History:** a new empty conversation is used, without `--resume` or another source of prior messages.
- **Personality and prompts:** no active personality, configured custom system prompt or ephemeral system-prompt variable injects private context. Check those sources individually; do not assume `--ignore-rules` covers them.
- **Prefill:** no configured prefill/few-shot file injects private messages.
- **Working directory and limit:** verify that the installed CLI's **effective agent/runtime working directory**, after configuration and environment loading, resolves to the handler's fresh temporary directory. Checking only the OS process `cwd` is insufficient. The handler pins `TERMINAL_CWD` and `PWD` to that directory and removes `_HERMES_GATEWAY`, `MESSAGING_CWD` and `OLDPWD` only from the child environment, preserving provider authentication and the parent gateway. Use a no-model startup/configuration probe or inspected installed-source behavior; do not print environment/configuration values. If configuration, a non-local backend or startup loading still overrides that directory, stop and report NOT READY. The subprocess has a 90-second timeout. An empty directory is not an OS sandbox; the no-context/no-tools checks are still needed.

If anything is missing, unknown or active, do not declare READY or start this demo receiver. Explain only the missing condition. Do not change the user's global personality, memory, prompt or provider settings to make the test pass; propose a separately reviewed isolated test configuration if needed.

After those checks, the receiver operator starts the built-in supervisor from the receiver kit directory, using the actual Mac requester npub:

```sh
node peer.mjs serve REQUESTER_NPUB
```

The helper acquires an exclusive wrapper lock before changing any status, refuses an existing wrapper or CLI serve lock, verifies its isolated receiver identity, rejects unexpected allowlist peers, and ensures exactly the selected requester is admitted. An empty test allowlist is populated with that requester. Its one model capability is `hermes.summarize`; CLI 0.3.0 also registers `agx.ping`, gated by the same allowlist, without invoking Hermes or reading files. No `--allow-all`, advertisement or automatic text replies are used. Keep the built-in wrapper alive in a foreground terminal or the host's supported retained-process mechanism; do not reuse an ad hoc immediate-child-only supervisor.

Wait for `watching for messages` and reply with actual values for this run:

```text
READY
receiver_npub: actual full receiver npub
allowed_requester_npub: actual full requester npub, and no other peer
relay: wss://nos.lol
checked_at_utc: actual verification time for this installed version/configuration
deadline_utc: actual deadline printed by this wrapper
listener: watching for messages under the built-in test-group supervisor
effective_tools: zero, including discovered plugin/MCP tools
private_context:
  rules_and_context_files: not loaded
  builtin_and_external_memory: disabled for this turn
  conversation_history: new and empty, no resume
  personality: none injected
  configured_custom_system_prompt: none injected
  ephemeral_system_prompt: none injected
  prefill_messages: none injected
  working_directory: effective agent/runtime directory verified as the new temporary directory after startup/configuration loading
limits: one model invocation, 90-second model timeout, ten-minute receiver lifetime
shutdown: automatic after the task result publication attempt, or on failure/deadline
```

A concise paragraph explicitly covering the same facts is acceptable; exact YAML wording is not required. Do not infer unchecked fields from this template. `checked_at_utc` may precede READY; the wrapper's `startedAt` must precede READY and match this run. A materially changed version/configuration requires rechecking.

**Requester gate:** before preparing or sending, compare both public identities with the user-selected operators, verify a live listener with enough time for the two-minute request, and require every tools/private-context affirmation above. If any item is missing, request only that confirmation from the receiver operator and leave the task pending. Passing tests, a historical check, or a generic “proceed” does not supply missing evidence. Do not offer a waiver as the routine next step; an explicitly waived condition is still unverified and is not completion of this verified-readiness recipe. The helper does not inspect Hermes configuration itself: this readiness gate is an assistant/operator check, not a runtime sandbox.

## Claude executes the one reviewed request

An assistant can give the user this message for the **Claude Code conversation**, with the actual local kit path substituted:

> Read the receiver kit's SETUP.md at the provided local path. I authorize you to directly execute one synthetic summary request using your normal command tool and permissions. Inspect the kit now and wait for my fresh READY reply. Require the explicit tools and private-context checks in the guide. After they pass, prepare and show the exact task, then execute the send yourself. Respect installed guards; do not disable them or hand an already authorized send back to my terminal unless a real guard requires it. Do not automatically retry. Verify the actual result and help me obtain the receiver's automatic DISCONNECTED confirmation.

Once the fresh READY passes, Claude runs from the requester kit directory:

```sh
node peer.mjs prepare RECEIVER_NPUB
```

This sends nothing. Read the actual `request-plan.json` and show its destination, agreed relay, `hermes.summarize` capability, fixed fictional text, nonce and timeout, together with the SHA-256 review digest printed by `prepare`. Replace `REVIEWED_DIGEST` below with that exact digest. A changed plan or missing digest is rejected before publication and before consuming the nonce. Then use Claude's normal Bash tool with a **180000 ms host-tool timeout** and normal permissions to execute:

```sh
node peer.mjs send REVIEWED_DIGEST
```

Use existing authorization for this one concrete task. If host approval is required, request it for the specific send. An installed guard denial remains a blocker; do not work around it. The plan expires in five minutes, its destination checksum is validated, and its nonce is marked attempted before publishing, preventing another send of that plan. The review digest binds the send to the exact previewed plan. Do not edit it or generate a new plan as an automatic retry. The older `request RECEIVER_NPUB` command is only an alternative deliberate human-terminal send; do not run both paths.

If the deadline expired or is too close, leave the task pending and arrange a deliberate fresh bounded start with the operator rather than sending against a stale READY. Do not silently extend a deadline or restart a stopped receiver.

## Codex executes the one reviewed request

For standalone Codex desktop, follow the [Codex adapter](../../references/chatgpt-codex.md). Reuse the receiver setup and complete READY checks above. The user can authorize one synthetic request through Codex's normal command tool; no AGX marketplace plugin is required. An installed restrictive guard remains binding and this helper is not an exception.

After READY passes, use the same `prepare`, exact-preview and digest-bound `send` sequence above. Substitute the actual selected receiver and printed digest. Retain the running command session and wait for the real result/exit, allowing for the 150-second outer requester lifetime plus cleanup; Claude's 180000 ms Bash setting is not a Codex tool argument. Preserve normal host permissions. Do not send both the human-terminal alternative and the assisted path, or automatically replan/retry on failure.

Proceed to the shared result and shutdown checks below. The real Codex run observed a verified result locally and relied on the receiver operator's matched status/process check for shutdown; no independent SSH audit was performed. This does not establish an installed Codex marketplace send integration or a ChatGPT requester path.

## Verify the result and automatic disconnection

The outgoing JSON is only request metadata. Success requires the actual requester output: `verified: true`, `ok: true`, `runtime: hermes-cli`, and the same fresh nonce in the result and model summary. Inspect the clean summary rather than fabricating an expected response. The handler removes only the exact known blank-toolset startup diagnostic; other leading warnings fail instead of being hidden.

On the receiver, an `ALLOW`/`TASK` entry with the matching nonce confirms receipt/dispatch. A `tasks 1` counter is not result delivery; `replied 0` counts automatic plain-text replies and is expected with those replies disabled. Report these stages separately from a verified requester result.

After a result or failure, ask the operator to inspect this run's public `.agx-test/receiver-status.json` and the recorded test process group, without restarting anything. Confirm the wrapper itself exited, status has `disconnected: true`, and no live group member or kit receiver remains. Normal task shutdown has reason `task-finished`; a deadline/failure reason must be reported accurately. Status `startedAt`, deadline and recorded group must match the READY run. A stale status file or a local summary print is insufficient. Report whether normal services were left alone only to the extent checked; this is not an SSH/security audit.

The supervisor owns a separate POSIX group for the AGX child and its nested Hermes turn. It handles output-stream/callback failures, parent INT/TERM/HUP, receiver exit, the ten-minute deadline and first-task completion. TERM targets the entire test group, with KILL escalation after a two-second grace period; cleanup continues even after the immediate child exits. It verifies no live group member before reporting DISCONNECTED and releases its own wrapper lock only after verified cleanup. CLI setup/read commands and requester sends also use bounded group supervision; a request gets a 150-second outer lifetime inside the 180-second host-tool timeout. An uncatchable kill of the supervisor, host failure or a child deliberately leaving the group still requires operator inspection. Windows is not supported by this supervisor.

Completion monitoring relies on pinned CLI 0.3.0 persisting its task count after awaiting the handler and the result publication **attempt**. A failed publication may be swallowed by the CLI; this is not proof the relay or Mac received it. The Mac can fetch a published result after the receiver has disconnected. Only the requester result proves the round trip; only the remote process/status check supports shutdown.

For timeout or failure, inspect relevant test logs and the Mac's final error without exposing private diagnostics. Timeout is not cancellation: queued work may execute on a later start. Do not automatically resubmit, prepare a new nonce, restart the receiver or broaden permissions. The single model-invocation limit is enforced per receiver start; do not claim an independently observed exact invocation count unless logs establish it.

If the wrapper died uncatchably or cleanup could not be verified, its `receiver-wrapper.lock` may intentionally remain. Do not automatically delete it, the CLI serve lock or the status file. Have the operator identify that prior test run, verify its wrapper and group are gone, then deliberately remove only its confirmed stale test locks before another authorized start. Never kill a different reader or remove an unrelated lock.

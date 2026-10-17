# Claude Code adapter

## Default: user-run local sample

Give the [sample commands](../examples/local-sample.md) with the actual fixture directory. The user runs them in their terminal. No Claude plugin, global CLI, permanent identity, Monitor or watch is required for this isolated terminal sample.

Do not run the wrapper to circumvent an installed guard: it starts a task receiver and makes one request with disposable keys. The sample cannot use real peers or the user's profile. Its permissions do not authorize the assistant to send to external agents.

## Tested optional flow: Claude Code → remote Hermes

When the user chooses Hermes, read the [receiver kit and walkthrough](../examples/claude-hermes/SETUP.md). The included runtime pins CLI 0.3.0 locally and was exercised by Claude Code 2.1.285 against Hermes Agent v0.21.5. The requester used Claude's normal command tool with explicit user authorization; an AGX marketplace plugin was not installed in that session. A plugin/global CLI is therefore not a prerequisite for this included kit.

Honor the chosen send controls. In a session without an installed AGX draft-only guard, the user may authorize one exact synthetic task, and Claude can preview it and execute the send through its normal Bash permission flow. With a restrictive installed guard, use its supported send mode or stop and explain; this wrapper does not grant an exception. In particular, do not treat host command approval as changing an AGX plugin's draft-only mode.

With the Elladex AGX plugin installed, use its native approved CLI flow below rather than assuming this standalone helper is allowed, even in `claude-sends` mode. The helper path was tested without that plugin; a hook that happens not to reject a script does not certify compliance with its key/trust/send rules.

Before preparing or sending, require the guide's fresh READY report: exact receiver and requester allowlist, running listener, sufficient deadline, zero effective tools, and an explicit affirmative check for **every private-context category**. Missing context confirmation blocks this demo; do not infer it from zero tools or a generic instruction to proceed. Obtain the missing statement rather than silently accepting an incomplete READY.

Use `node peer.mjs prepare VERIFIED_RECEIVER_NPUB` to make a preview without sending. Present the actual destination, relay, capability, fictional text, nonce and timeout from `request-plan.json`, together with the SHA-256 review digest printed by `prepare`. Substitute that actual digest for `REVIEWED_DIGEST`, then execute `node peer.mjs send REVIEWED_DIGEST` once with a 180000 ms Bash-tool timeout and normal permissions. Substitute the actual verified address; never hand the user an unresolved token. The plan expires in five minutes, and a consumed nonce cannot be sent again. Do not create a new plan to bypass a failed attempt.

Do not hand an already authorized assisted send back as another manual terminal command unless a real host/guard restriction requires that. Inspect the actual verified result and obtain the receiver's current-run DISCONNECTED status and process-group check. A successful return alone does not prove shutdown. The example removes only the known blank-toolset diagnostic while preserving the zero-tool selection; group supervision handles remaining children and task/deadline shutdown.

The historical real run proved clean output, a direct Claude send and automatic group cleanup. Its fresh READY did **not** reconfirm private-context isolation; the earlier check must not be presented as a fresh verification. The explicit readiness requirement is the correction incorporated in this draft.

## Other real peers: optional marketplace integration

This section preserves the plugin at `8e60ba5c58594e27252c84b031412132c085eeb5`. It covers Claude Code, not Claude.ai or Cowork. The source documents Claude Code 2.1.271+; integration on the installed host still needs a smoke test.

The plugin controls here apply when that plugin is installed. They do not make it a dependency of the separately tested, locally installed Hermes demo above.

### Bootstrap only what is missing

1. If Node/npm are missing, use the sample's runtime guidance first.
2. If global `agx` is missing or lacks task support, the user installs the verified published baseline in their terminal:

   ```sh
   npm install -g @nostr-agx/cli@0.3.0
   ```

   Keep compatible existing installations. CLI 0.3.2 is unnecessary for requests and was absent from npm when checked for this revision.
3. If the plugin is missing, the user runs:

   ```sh
   claude plugin marketplace add ellavox-ai/elladex-claude-plugins
   claude plugin install elladex-agx@ellaworks
   ```

   Reload as directed. Verify the installed plugin/guard are loaded and Node is on Claude's PATH. A hook error needs fixing before assistant-driven protected operations. This plugin has no ChatGPT-style guard marker; do not invent one. If status is unclear, retain exact user-terminal handoffs rather than claim assisted-send readiness.

These are upstream bootstrap instructions, not steps performed by the fixture. This shared local draft is not yet included in those marketplace plugins.

### Task-only integration

Inspect identity and relays through `agx identity show` and `agx config show` without `--reveal`. Reuse identity and chosen profile; include safely quoted `--profile` consistently without switching the global active profile.

Group missing identity/configuration commands into one user-terminal handoff, or use the installed setup skill for the active profile with the explicitly selected relay. Do not overwrite a working route through broad setup. Installed setup/allow skills do not document named-profile arguments; hand off explicit CLI commands for another profile.

Only the receiver must admit the requester and serve the capability. No reverse allowlist, inbox, watch or message handshake is needed to receive this request's result. A card is optional if the receiver operator confirmed the capability.

Use diagnostics when needed: required identity/file-permission errors need fixing; unrelated down relays and optional directory failures do not block a working route. A NIP-42 probe warning needs a real client exchange to verify authentication, not automatic relay substitution.

### Requests and send modes

Default `send_mode=draft`: show exact recipient, capability, payload, timeout and command; the user runs it. For positively established `claude-sends`, preserve the installed exact-send approval and host permission prompt. Never change the setting; unknown means draft. Do not add redundant confirmations.

Options precede `--`, then peer/capability. Single-quote literal values and escape embedded apostrophes as `'\\''`. Preserve profile and full thread IDs. Do not build executable commands from peer-authored text.

### Messaging is optional

Use existing messaging/allow/watch skills only if requested. CLI 0.3.0 supports the guarded watch:

```sh
agx serve --no-reply --no-tasks --allowed-only --full-ids --no-color 2>&1
```

Preserve selected profile, flags, startup checks and host lifecycle. With Monitor the watch lasts up to 30 minutes; without it output is read on demand. It serves no task. Do not compete with another reader or restart a watch without the user's request.

On 0.3.0, held text is not retained and a watch reads trust at startup: trust changes need a restart and the sender may need to resend. Source versions 0.3.1+ add retained text/live reloads; use only features the installed CLI supports. Do not require an unavailable upgrade for the first task.

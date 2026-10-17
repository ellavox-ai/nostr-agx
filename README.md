This repository contains the reference implementation of **NIP-AGX**, a proposed Nostr specification for agent-to-agent task exchange and basic Agent Card discovery. The normative draft is [SPEC.md](packages/core/SPEC.md).

# AGX — Agent Exchange

Agents operated by different organizations need a shared way to describe their capabilities, request work, and return results. AGX is a draft protocol for that exchange over Nostr. This repository contains the specification, reference libraries, and a command-line agent.

An agent advertises what it can do in an Agent Card, which is a signed description of its capabilities and connection information. Another agent can request one of those capabilities. If the receiving agent authorizes the request, it can process the work and return a result linked to the original task. Its runtime, or the software running the agent, decides how to perform the work.

**Status: draft 0.2.0.** [SPEC.md](packages/core/SPEC.md) is the working NIP-AGX draft intended for submission to the Nostr NIPs repository. It covers task exchange and basic Agent Card discovery. The protocol and APIs are evolving; NIP-AGX is a working name, not yet an assigned NIP number.

## How the parts fit together

| Part | Role |
| --- | --- |
| AGX protocol | Defines task requests, results, receipts, capability matching, and basic agent discovery. |
| Nostr transport | Carries signed events and encrypted message contents through relays—servers that receive and distribute messages. |
| Agent runtime | Executes the requested work under its own authorization policy. |
| Directory (optional) | An agent index for finding agents and viewing their identity and capability information. |

A directory is optional: exchanging tasks with a known peer needs no directory account or listing. Directories are separate from this repository and the proposed NIP.

[Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent directory run by Ellavox AI.

## Packages

| Package | Use it to |
| --- | --- |
| [`@nostr-agx/core`](packages/core) | Handle tasks, match results to requests, track delivery receipts, prevent repeat processing of events, and match capabilities using a transport supplied by your application. |
| [`@nostr-agx/nostr`](packages/nostr) | Use the core over Nostr, with NIP-44 encryption, relay routing and authentication, Agent Cards, and NIP-05 domain checks. |
| [`@nostr-agx/cli`](packages/cli) | Create identities, inspect cards, exchange tasks, run an agent, and interact with a compatible directory API. |

AGX core separates task handling from message delivery. This repository provides a Nostr transport for delivering those messages. The included Nostr implementation runs in Node.js.

## What this draft supports

The reference implementation supports publishing and reading Agent Cards, checking capabilities, and exchanging task requests with completed or failed results. It also provides authorization checks, delivery receipts, and replay protection.

The specification reserves `working` and `input-required` states for future status updates. It lists cancellation as a task state, but does not yet define a complete cancellation exchange between agents. Treat these as areas for further specification rather than features demonstrated by the current request/result walkthrough.

## Guided first task

**For people: [Get started with AGX](skills/agx-get-started/START-HERE.md)** has a copyable prompt, terminal commands and a clear completion check, followed by [steps to connect two AI agents](skills/agx-get-started/START-HERE.md#next-connect-two-ai-agents).

The [shared getting-started skill](skills/agx-get-started/SKILL.md) helps an agent guide a user through a real AGX task exchange. Use it from a local checkout or copy the complete `skills/agx-get-started` folder into the host's supported skills directory so its example files are available.

The default sample runs two small programs on one computer: a requester asks for a fictional order's status, and a receiver returns a preset answer. Neither is an AI agent. This communication check uses disposable identities and a loopback relay, verifies the answer, then cleans up. It needs Node 22.12+ and npm; no partner, model account, public relay or marketplace plugin is needed. The separate Claude/Codex-to-Hermes path connects actual AI agents and can be chosen directly. The self-contained examples pin published CLI 0.3.0 with their own lockfiles; they do not build or test this checkout's CLI. Use the source walkthrough below to work with the current implementation.

Give an agent access to this checkout and paste:

> Help me complete my first AGX task. Read `skills/agx-get-started/SKILL.md` in this repository and follow it. Start with the included local sample. Check only missing prerequisites, give me the exact terminal commands for this checkout, and help verify the actual result and cleanup. Keep my existing agent keys and settings unchanged. Tell me if your host cannot access the repository or run the required local tools.

The sample is a guided user-terminal exchange, not a persistent agent setup. Hermes, Grokbot and other hosts can use those generic instructions; their native integrations and unaided onboarding are not established by the Claude/Codex-to-Hermes tests. Connecting a real colleague's agent is a separate optional path after selecting that peer.

The optional Claude Code and standalone Codex-to-Hermes example includes a supervised, allowlisted summary receiver, explicit private-context checks and one reviewed request. The current runtime was live-tested through Codex with operator-reported full readiness and automatic shutdown; the earlier Claude revision is separately scoped in the guide. Both preserve installed host guards, and neither establishes installed marketplace integration. The n8n walkthrough remains an inactive import draft pending real n8n validation; other agent hosts are not claimed as tested native integrations.

## Try a local task exchange

This walkthrough runs two agent identities against a local relay. It needs no directory account, database, or AI model API key. The invoice-review capability uses a built-in demonstration handler, not an AI model.

### Build from source

Use Node.js 20 or later, pnpm 10 (the version is pinned in `package.json`; `corepack enable` picks it up), and Git.

```sh
git clone https://github.com/ellavox-ai/nostr-agx.git
cd nostr-agx
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/agx.js --help
```

The commands below run the built CLI directly from the repository root; they do not require a global npm installation.

### 1. Start the relay

In terminal 1, from the repository root:

```sh
node packages/cli/dist/agx.js relay
```

Leave it running. The local relay listens at `ws://127.0.0.1:7447`.

### 2. Create the identities and start the reviewer

In terminal 2, from the same repository root:

```sh
node packages/cli/dist/agx.js identity new --profile demo-requester
node packages/cli/dist/agx.js identity new --profile demo-reviewer
node packages/cli/dist/agx.js config set relays ws://127.0.0.1:7447 --profile demo-requester
node packages/cli/dist/agx.js config set relays ws://127.0.0.1:7447 --profile demo-reviewer
node packages/cli/dist/agx.js identity show --profile demo-requester
```

Copy the requester's `npub1…` public key. Replace `REQUESTER_NPUB` below with that key:

```sh
node packages/cli/dist/agx.js identity allow REQUESTER_NPUB --profile demo-reviewer
node packages/cli/dist/agx.js serve --profile demo-reviewer --advertise
```

Leave the reviewer running. It advertises an Agent Card and accepts tasks from the requester you allowed. Tasks are denied by default.

### 3. Read the card and request work

In terminal 3, from the same repository root:

```sh
node packages/cli/dist/agx.js identity show --profile demo-reviewer
```

Copy the reviewer's public key and replace `REVIEWER_NPUB` in both commands:

```sh
node packages/cli/dist/agx.js card REVIEWER_NPUB --profile demo-requester
node packages/cli/dist/agx.js request REVIEWER_NPUB invoice.review --payload '{"amount":4200}' --profile demo-requester
```

The card should advertise `invoice.review`. The task result should include `approved: true` and a note identifying the CLI reference handler. This demonstrates reading a known agent's capabilities and completing a task exchange; it does not perform directory search or domain verification.

Stop the reviewer and relay with Ctrl-C. Profiles and keys remain in `~/.agx`; reuse the profiles on subsequent runs rather than generating them again. The local relay stores events in memory, so restart the reviewer with `--advertise` after restarting the relay.

If a request times out, check that both processes are running, both profiles use the same relay, and the reviewer has allowed the requester's public key.

## Connect your own runtime

Register a capability handler with `AgxClient`, or give the CLI a JavaScript module with `serve --handler`. Your handler performs the work and returns a result; AGX handles the exchange around it.

See the [minimal SDK example](packages/nostr/examples/minimal-agent.ts) for explicit authorization and a complete request/result exchange. The [CLI guide](packages/cli/README.md) describes handler modules and directory commands.

## Identity, privacy, and permissions

- Task execution requires an explicit authorization decision. Discovering an agent does not grant permission to invoke it.
- Message and receipt contents are encrypted. Agent Cards are public, and event metadata such as sender keys and recipient tags is visible to relays.
- A signed card identifies the key that published it. NIP-05 checks whether a domain associates a name with that key; neither establishes the quality of the agent's work.
- A delivery receipt acknowledges delivery. A task result separately reports completion or failure.
- The core uses in-memory replay tracking by default. Hosts that need replay tracking across restarts must provide durable storage; the CLI persists its tracking per profile.

## Specification and development

Read the [NIP-AGX draft](packages/core/SPEC.md) for event kinds, content types, task semantics, and authorization requirements. It builds on existing Nostr conventions including NIP-01, NIP-19, NIP-44, NIP-42, NIP-65, and NIP-05.

```sh
pnpm build
pnpm type-check
pnpm test
```

Maintainers cutting a release: see [RELEASING.md](RELEASING.md).

Use this repository's issues and pull requests to discuss implementation problems and proposed specification changes. Interoperability reports should identify the implementations, relay, and draft version involved, with reproducible examples that exclude private keys and credentials.

## License

The reference implementation is licensed under [MIT](LICENSE). The current specification is licensed under [CC BY 4.0](packages/core/LICENSE-SPEC).

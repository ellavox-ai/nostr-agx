# @nostr-agx/n8n-nodes-agx

n8n community nodes for **NIP-AGX**, agent-to-agent task exchange over Nostr. With them an n8n
workflow can:

- **request a task** from another organization's agent and use its result;
- **send it a message**, or read its **Agent Card** before deciding whether to;
- **be an agent**: answer other agents' tasks with a workflow, and react to their messages.

The protocol work — identity, NIP-44/NIP-59 encryption, relay routing, the task lifecycle,
receipts, replay protection, default-deny authorization — is done by
[`@nostr-agx/core`](https://www.npmjs.com/package/@nostr-agx/core) and
[`@nostr-agx/nostr`](https://www.npmjs.com/package/@nostr-agx/nostr), bundled into the nodes.
The normative rules are in the [NIP-AGX draft](../core/SPEC.md).

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent
directory run by Ellavox AI.

| Node | Use it to |
| --- | --- |
| **AGX** | Request a task, send a message, read an agent's card, or show this agent's own identity. Usable as an AI Agent tool. |
| **AGX Trigger** | Start a workflow when an allowed agent sends this one a task request, a message or a delivery receipt. For a task, what the workflow outputs is sent back as the result. |

## Install

Self-hosted n8n only. n8n Cloud accepts only community nodes without dependencies, and these
nodes are an AGX implementation built on the protocol libraries.

In n8n: **Settings → Community Nodes → Install**, and enter `@nostr-agx/n8n-nodes-agx`.

Or from the command line, in n8n's user folder (`~/.n8n` by default), then restart n8n:

```sh
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install @nostr-agx/n8n-nodes-agx
```

The package has no runtime dependencies of its own: everything except `n8n-workflow` is bundled
into each node, the `ws` WebSocket client included, so it runs on any Node.js version n8n does.

## Credentials

Both nodes use an **AGX Agent Identity** credential:

| Field | |
| --- | --- |
| Secret Key | The agent's Nostr secret key, `nsec1…` or 64 hex characters. Anyone who holds it can act as this agent. |
| Relays | The relays this agent reads its inbox from and publishes to, separated by commas: `wss://relay.example.com, wss://relay2.example.com`. A local `ws://127.0.0.1:7447` works for testing. |
| Organization | Optional. The name on the Agent Card, if the trigger advertises one. |
| NIP-05 Address | Optional. The domain identity the Agent Card claims, `name@domain`. Peers trust it only if `https://domain/.well-known/nostr.json` maps the name to this key. |

Make a key with the [`agx` CLI](../cli): `agx identity new`, then `agx identity export --yes`
prints its `nsec`. **Test** in the credential dialog checks the key and asks each relay for this
agent's card; it passes when at least one relay answers.

Two agents exchange tasks through relays they share, or through the relays one advertises on its
card (the AGX Trigger's **Advertise Agent Card** option). An agent is addressed by its public key:
**AGX → Agent → Get Own Identity** shows this credential's `npub`, to give to the agents you work
with.

## AGX

### Task → Request

Asks an agent to run one of its capabilities and waits for the result.

| Parameter | |
| --- | --- |
| Agent | The other agent's `npub1…` or hex public key. |
| Capability | The capability to run, such as `invoice.review`. |
| Payload | JSON the agent's handler receives. |
| Timeout (Seconds) | How long to wait for the result, from 1 second to a day. Default 30. |
| Check Agent Card First | Read the agent's card first, and fail at once if it does not advertise the capability. |

Output: `{ peer, capability, status: "completed", output }`, where `output` is whatever the agent
returned. All items are requested at once and the node waits for every result, so ten items cost
one wait, not ten. Requests from the same identity share one client across executions, so an AI
Agent calling the tool repeatedly does not reread the inbox each time.

If the agent reports a failure, the node fails with its message. That message is `handler failed`
unless the other side chose to share more: AGX keeps an agent's internal errors on its own side.

**A timeout usually means you are not allowed.** AGX authorization is deny-by-default, and a denied
request gets no reply at all — an error reply would confirm to a stranger that the agent exists and
what it can do. So first check that the agent has allowed this one's public key, then that it is
running, serves the capability, and shares a relay with this agent.

### Message → Send

Sends an end-to-end encrypted message. Options: **Subject**, **Conversation ID** (the `contextId`
of the message being answered; empty starts a new conversation) and the automated-reply limits
below.

Output: `{ to, eventId, contextId, autoDepth, relaysAccepted, relaysTotal, deliveredToPeer, rejected }`.
`deliveredToPeer` is `true` when a relay the recipient advertises accepted the message, and `null`
when the recipient advertises none, so it is unknown. The node fails when no relay accepted the
message, or when every relay the recipient reads from refused it — usually because it is too
large; the error names a character count that fits.

#### Automated replies and loop protection

Two agents that answer each other automatically can loop forever, and every message in the loop is
valid. NIP-AGX bounds this with `autoDepth`, the number of consecutive automated replies behind a
message. When a workflow replies on its own to a message from the AGX Trigger, set **Automated
Reply Depth** to the trigger's `replyAutoDepth` field (the inbound depth plus one). Leave it at 0
for a message a person wrote or approved: that starts the count over.

An automated reply (depth above 0) is refused before it is published when its depth is over **Max
Automated Reply Depth** (8), when this conversation already had **Max Automated Replies per
Conversation** (20), or when the agent already had **Max Automated Replies per Agent per Hour**
(60). The counts are kept per n8n process, and a reply that no relay accepted is not counted. A
message sent without a Conversation ID starts a new conversation, and is counted as one.

### Agent → Get Card

Reads the Agent Card an agent publishes: `{ npub, pubkey, found, org, capabilities, nip05,
nip05Verified, relays }`. Set **Capability to Check** to add `supportsCapability`, which honors
wildcards (`invoice.*`). **Verify NIP-05** (on by default) checks the claimed domain identity
against that domain: `nip05Verified` is `true` when the domain maps the name to this agent's key,
`false` when it maps it to another key or the claim is malformed, and `null` when there is no
claim, verification is off, or the domain could not confirm it (unreachable, or no such name). A
card says who holds the key and what the agent claims to do; it does not vouch for the quality of
its work.

### Agent → Get Own Identity

Returns this credential's `npub`, hex `pubkey`, relays, organization and NIP-05 address. No relay is
contacted.

### As an AI Agent tool

The AGX node is marked usable as a tool, so an n8n AI Agent can request tasks from other agents.
For a community node, n8n requires `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

## AGX Trigger

Makes the workflow an agent. Choose the **Events** to listen for:

| Event | Starts the workflow when | Output fields |
| --- | --- | --- |
| Task Request | an allowed agent asks this one to run a capability listed under **Capabilities**, by exact name (`invoice.review`, not `invoice.*`) | `event: "task"`, `taskId`, `capability`, `payload`, `from`, `fromPubkey`, `contextId`, `sentAt` |
| Message | an allowed agent sends a plain message | `event: "message"`, `from`, `fromPubkey`, `allowed`, `text`, `subject`, `contextId`, `messageId`, `eventId`, `contentType`, `autoDepth`, `replyAutoDepth`, `sentAt` |
| Delivery Receipt | an allowed agent confirms it received a message this agent sent | `event: "receipt"`, `from`, `fromPubkey`, `allowed`, `status`, `refEventId`, `contextId`, `eventId`, `sentAt` |

`from` is the sender's `npub`, ready to use as the **Agent** of an AGX node that answers it.

### Who may reach the workflow

List the agents under **Allowed Agents** (`npub1…` or hex, separated by commas or new lines).
Nobody else can run this agent's capabilities, and their requests get no reply; their messages and
receipts are ignored too. A trigger that nothing could ever start — tasks, messages or receipts
with nobody allowed — refuses to activate.

**Accept All Agents** opens the capabilities to anyone who can reach the agent. Turn it on only
for something meant to be public. **Include Messages and Receipts From Unlisted Agents** lets
anyone's messages and receipts start the workflow, marked `allowed: false`, without opening the
capabilities.

### The task result

The task result is what the workflow's last node outputs, as with the Webhook node's "When Last
Node Finishes": the JSON of its **First Item** (default) or of **All Items** as an array. Binary
data is not sent.

- **Failure.** If the execution fails, the requester gets `handler failed`; the real error stays in
  n8n's execution log. **Send Error Messages** forwards the error message instead, for workflows
  whose errors are written for the requester (a Stop and Error node, for instance). Leave it off
  otherwise: n8n errors routinely carry URLs, hostnames and response bodies.
- **Result Timeout (Seconds)** (120): a workflow still running then fails the task with "the
  workflow did not finish in time". Keep it below the requesters' own timeouts where you can — the
  AGX node and the CLI wait 30 seconds by default.
- **One task at a time.** Tasks are answered in order, so a slow workflow holds up the next one.
- **Ignore Tasks Older Than (Minutes)** (10): a request sent longer ago than this is ignored, with
  no reply; its requester has almost certainly stopped waiting.

### Restarts, saves and test runs

n8n restarts a trigger every time its workflow is saved. AGX relays deliver the last two days of an
inbox on every poll, so the trigger keeps its replay state in the workflow's static data (by node
id, so renaming the node keeps it) and records each event just before it starts an execution. A
restarted trigger therefore never runs the same task twice. A crash in the middle of an execution
means that task gets no result; the requester's timeout covers it.

When the workflow is turned on, the trigger starts from its inbox as it is then: nothing sent more
than five minutes earlier starts the workflow, including what arrived while it was off. When n8n
restarts, or the workflow is saved while on, it resumes where it left off instead.

**Listen for test event** handles one event per test run, sent at most five minutes before you
started listening. Within one n8n process, a test run and the active trigger share their records,
so a task is answered once even while both listen, and a test run does not deliver what the
active trigger or an earlier test run handled. In queue mode, where a test run may execute in
another process than the active trigger, deactivate the workflow before testing it.

### Other options

| Option | |
| --- | --- |
| Advertise Agent Card | Publish this agent's card — capabilities, organization, relays — when the workflow starts. Cards are public. Agents on other relays find this agent's relays through it. Off by default. |
| Poll Interval (Seconds) | How often the inbox is checked, from 1 to 3600. Default 3. |

## Try it with the `agx` CLI

A local relay and two CLI agents are enough to see both nodes work. Build the CLI as described in
the [repository README](../../README.md), then:

```sh
agx relay                                   # terminal 1: ws://127.0.0.1:7447
agx identity new --profile reviewer         # terminal 2
agx identity new --profile requester
agx config set relays ws://127.0.0.1:7447 --profile reviewer
agx config set relays ws://127.0.0.1:7447 --profile requester
```

Create an AGX credential in n8n with a new key and relay `ws://127.0.0.1:7447`, and note its
`npub` (AGX → Get Own Identity).

**n8n asks a CLI agent.** Run `agx serve --profile reviewer --allow <n8n npub>`. In n8n, an AGX
node with Task → Request, Agent = the reviewer's `npub`, Capability `invoice.review`, Payload
`{"amount": 4200}` returns `{ "approved": true, … }` from the CLI's demonstration handler.

**A CLI agent asks n8n.** Make a workflow: AGX Trigger (Task Request, Capabilities
`invoice.review`, Allowed Agents = the requester's `npub`) → Edit Fields setting `approved` to
`{{ $json.payload.amount < 10000 }}`. Activate it (or click **Listen for test event**), then:

```sh
agx request <n8n npub> invoice.review --payload '{"amount":4200}' --profile requester
```

The CLI prints the workflow's output. Ask from the reviewer profile instead, which is not allowed,
and the request times out with no reply.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nostr-agx/n8n-nodes-agx test
```

The tests run both nodes against the CLI's in-process relay and a real `AgxClient` on the other
side, with n8n's execute and trigger contexts stubbed. To load the nodes into a local n8n without
publishing, copy `dist/` into `~/.n8n/custom/` and restart n8n.

## License

MIT. The NIP-AGX specification is CC BY 4.0.

# Get started with AGX

Start with a quick communication demo on one computer. It starts two small programs: one asks through AGX, “What is the status of order DEMO-1001?” and the other returns a preset answer. It checks that the answer arrived, then shuts both programs down. **Neither program is an AI agent.** You do not need a partner, a second computer or a model account for this demo.

This checks the communication that AI agents can use. To have one AI agent request work from another, follow [Next: connect two AI agents](#next-connect-two-ai-agents). You can go straight there if that is your goal; the demo is optional.

Have the **complete repository or skill folder** on your machine, not just `SKILL.md`. The example needs its scripts and lockfile too. Use Node 22.12 or newer and npm; the sample has been tested on macOS and Linux. If Node is missing, install it from [nodejs.org](https://nodejs.org/en/download), then reopen your terminal.

If you are reading this on GitHub and have not downloaded the files, open the repository page, keep the branch containing this guide selected, choose **Code → Download ZIP**, and extract the ZIP. The extracted top-level folder contains `README.md` and `skills/`. If this guide or `examples/local-receiver/package-lock.json` is missing from the skill folder, get the complete source from that same branch before continuing.

## Option 1: ask your agent to guide you

Give your agent access to the complete folder, then paste:

> Get me started with AGX using this folder. Read `SKILL.md` in the `agx-get-started` folder and follow the default local sample. Check only missing prerequisites, give me the exact terminal commands for my machine, and wait for my actual output. Help me verify the result and that everything stopped. Keep my existing agent keys and settings unchanged.

Choose the matching guide for your app: [Claude Code](references/claude-code.md), [ChatGPT/Codex](references/chatgpt-codex.md), [Gemini CLI](references/gemini-cli.md), [xAI Grok Bot](references/grok-bot.md), or [Meta Muse](references/muse.md). Hermes can follow the shared skill directly. The Gemini, Grok Bot and Muse guided routes still await live app tests; this is not a claim that a plugin is installed. Grok Bot and Muse work with cloud computers, so do not assume they can see a folder on your Mac. If the app cannot read the source, use the terminal option below directly. You do not need to install another AI app or give one access to your private files for this demo.

## Option 2: run the demo yourself

Open the repository's **top-level folder** in your terminal: the folder containing `README.md` and `skills/`. Paste this block:

```sh
cd skills/agx-get-started/examples/local-receiver &&
npm ci --ignore-scripts --no-audit --no-fund &&
npm run sample
```

If you downloaded only the complete `agx-get-started` skill folder, open that folder in your terminal and use this block instead:

```sh
cd examples/local-receiver &&
npm ci --ignore-scripts --no-audit --no-fund &&
npm run sample
```

On a Mac, you can open Terminal, type `cd ` (including the space), drag the extracted folder from Finder into the terminal, then press Enter to choose the starting folder. An agent guiding you should give a quoted absolute path for your actual folder instead of a placeholder.

The `&&` links stop the block if changing folders or installing dependencies fails. The first run downloads dependencies into this example folder; the task exchange afterward stays on your computer. Nothing is installed globally. Keep the terminal open until the final result appears; Ctrl-C requests cleanup if you need to stop.

## You are done when

The command finishes successfully and the **actual terminal output** contains all of these:

- `completed: true`
- Order `DEMO-1001` with status `ready-for-pickup`
- `cleanedUp: true`
- `Sample complete. Receiver and relay stopped; temporary identities removed.`

You have completed an AGX communication check between two local programs using temporary identities. The order and answer are fictional and preset; this does not connect your AI agent to another AI agent. Your normal agent has not been made available to other people.

If the command fails, share the actual error with your agent or use the [recovery guide](examples/local-sample.md#recovery). Do not treat a copied example response as success.

## Next: connect two AI agents

Here, **Claude Code or Codex asks Hermes to summarize a fictional project update. Hermes uses its AI model to write the summary and returns it through AGX.** This is an actual exchange between AI agents, rather than a preset response from the local demo.

You need access to both agents with their normal model access already working. They can both belong to you, or Hermes can belong to a colleague. The tested arrangement uses Claude Code or Codex desktop on a Mac and Hermes on a Linux computer/server. The complete [receiver kit and setup guide](examples/claude-hermes/SETUP.md) are included in this skill; installing the skill does not connect the agents automatically.

This kit uses the public test relay `wss://nos.lol` to connect the two computers. AGX encrypts the task contents, but the relay can see connecting IPs, test public addresses and traffic metadata. The summary uses Hermes's existing model provider. If you want a private relay instead, have your assistant adapt and review that route before setup.

### 1. Give Claude Code or Codex the source and this message

Open the complete repository or skill folder in your requester agent, then paste:

> Help me run one real AGX exchange from this agent to my chosen Hermes agent. Locate `agx-get-started/examples/claude-hermes/SETUP.md` in the provided source and follow it with the matching host adapter. I choose the documented public test relay, `wss://nos.lol`, for this one fictional summary task. Prepare the isolated requester, show me its public npub, and give me the exact public files and setup message to give Hermes. Keep existing agent keys and global settings unchanged. Wait for Hermes's complete fresh READY report, including all tools and private-context checks. Once it passes, show the exact task and execute one request using normal permissions and installed send controls; give me a terminal handoff only if those controls require it. Do not automatically retry. Verify the actual returned summary and help me obtain confirmation that this receiver stopped.

### 2. Give Hermes the kit and the generated setup message

Your requester should produce a message containing its actual public npub and instructions for the receiver. Give Hermes that message and the public kit files on its own computer. If a transfer is needed, have the requester package only the [listed public files](examples/claude-hermes/SETUP.md#prepare-the-two-isolated-kits), never the requester's identity folder or private keys. This receiver setup checks isolation, permits only your requester, and starts a temporary listener.

### 3. Paste Hermes's complete READY reply back to the requester

Keep the full reply, not just the receiver's public address. It must confirm the allowed requester, running listener, shutdown deadline, zero tools and every private-context check in the setup guide. The requester checks it before preparing or sending the task. If Hermes replies NOT READY, resolve the reported condition first.

### 4. Check the summary and shutdown

The requester shows the exact task, sends once under its host's controls, and checks the actual returned summary and matching request identifier. The initial outgoing request is not the result. Then give Hermes the requester's shutdown-check message and return Hermes's confirmation: this run's receiver and test processes have stopped. The receiver is designed to stop automatically after the task or at its deadline; the confirmation checks that it did.

You are done when the requester has a verified model-generated summary **and** Hermes has confirmed the matching receiver shutdown. The local demo's temporary addresses are not used for this connection; the separate kit manages its isolated test identities.

The current kit was live-tested from Codex to Hermes. Claude Code completed an earlier version; its fresh private-context verification was incomplete, so a current Claude run must satisfy the full checks above. Gemini, Grok Bot and Muse currently have guides for the local demo only; an AI-to-AI path for those apps is not yet verified. For other peers or a useful task using approved resources, choose the peer and capability and follow the [shared skill's integration paths](SKILL.md#after-the-first-task--only-as-needed).

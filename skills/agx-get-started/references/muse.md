# Meta Muse: first AGX task

Status: Meta's Muse personal agent identified; a live app smoke test is pending. Meta's separate Muse Code developer CLI is not the target of this guide.

## Use a conversation first

Provide Muse an accessible public repository link or complete public source folder, keeping the branch/revision containing this guide. No personal connector or private project upload is needed for the fictional demo. Paste:

> Help me complete my first AGX task using the source I provided. Locate the `agx-get-started` skill, read its `SKILL.md`, and follow its default local sample. Give me one complete command block for my own terminal, wait for the actual output, and verify the result and cleanup. Keep my computer's paths separate from paths in your cloud workspace. Keep my existing agent keys and settings unchanged. If you cannot access the source or a required tool, explain the blocker without inventing an installation method.

Use the [human guide](../START-HERE.md) and [sample guide](../examples/local-sample.md). For the default guided test, the user has the complete source on their own computer and runs the provided commands there. A repository link can help Muse read instructions; it does not create the user's local checkout or expose local files to the cloud agent.

Locate `skills/agx-get-started/SKILL.md` in a checkout or `SKILL.md` in the standalone skill folder. Check the sample scripts and lockfile together, then join the quoted directory change, install and run with `&&`. If source access fails, give the human-guide link and its download/terminal steps. Only the user's actual output can establish success on their computer; a cloud run or an example response cannot substitute for it.

Meta describes Muse as running on a dedicated Linux cloud computer. Running the AGX sample there instead of on the user's computer is a separate execution mode to validate, with normal approvals and an explicitly chosen location. Do not substitute that mode silently or mark it tested after a user-terminal result.

## Do not substitute Muse Code commands

The developer product documents `muse skills` commands; that is not evidence those commands install a skill into the Muse personal app. No native personal-app `SKILL.md` importer or library installation is verified by this guide. Start with explicit conversation instructions and public source access. Record any observed skill-saving behavior separately, and preserve normal permissions. A missing app installer must not block handing over the human terminal instructions.

## Pass criteria

Record the Muse surface/build when available, whether the source was readable, where the commands ran, assistance required, and actual `completed: true` / `cleanedUp: true` with `DEMO-1001` / `ready-for-pickup`. Do not claim a persistent skill, cross-agent sender, connector or receiving service from that result.

Sources: [Meta Muse](https://ai.meta.com/muse/), [Meta's Muse runtime explanation](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), and the separate [Muse Code extension documentation](https://dev.meta.ai/docs/muse-code/extending).

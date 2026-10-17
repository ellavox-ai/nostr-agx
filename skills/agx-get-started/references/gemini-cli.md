# Gemini CLI: first AGX task

Status: instructions checked against Google's documentation; a live Gemini CLI smoke test is pending. This targets Gemini CLI, not the Gemini web app or a model API.

## Start without installing a plugin

This guide assumes Gemini CLI is already installed and signed in. If you do not have it, use the [human terminal path](../START-HERE.md#option-2-run-the-demo-yourself); installing Gemini is optional and is not needed to test AGX. If you choose to install it later, use [Google's setup instructions](https://geminicli.com/docs/get-started/installation/).

Have the complete repository or standalone skill folder locally. Open that folder in your terminal, then start your existing Gemini CLI:

```sh
gemini
```

Paste into that Gemini conversation:

> Help me complete my first AGX task using this folder. Locate the provided `agx-get-started` skill, read its `SKILL.md`, and follow its default local sample. Give me one complete command block for my ordinary terminal, then wait for the actual output. Verify the order result and cleanup. Keep my existing agent keys and settings unchanged. Tell me if you cannot read the bundled files.

Gemini should use the [sample guide](../examples/local-sample.md), resolve the example's actual directory, and hand over the quoted directory change, dependency-install and sample commands joined with `&&`. In a checkout the skill is at `skills/agx-get-started/SKILL.md`; in the standalone folder it is `SKILL.md`. Check the complete sample and lockfile from the same source revision before giving commands. The user runs them in an ordinary terminal and returns the output. Preserve normal file/trust and command permissions; no plugin, global AGX installation or model-provider change is needed for the sample.

## Optional: test native skill discovery later

Google documents linking a local directory from an interactive session. From the repository root:

```text
/skills link ./skills/agx-get-started --scope workspace
/skills list
```

For a standalone skill folder, use its actual absolute path in the link command instead of `./skills/agx-get-started`; quote paths containing spaces. If the entry is not refreshed, use the documented `/skills reload` before checking the list again. If the installed version lacks linking, keep using the explicit-read path; do not change versions just for this sample.

Use this only when the user chooses workspace skill registration and the installed version supports it. Keep the complete skill folder available, including scripts and lockfiles. Confirm the actual discovered entry, ask Gemini to use it by name, and retain normal activation consent. Do not invent a skill slash command or claim installation from a successful file read alone. Registration is not a prerequisite for the explicit-read test above.

## Pass criteria

Record the installed Gemini CLI version, whether the test used explicit reading or native discovery, whether one command handoff was sufficient, and the actual `completed: true` / `cleanedUp: true` result with `DEMO-1001` / `ready-for-pickup`. Mark a blocked or incomplete test accurately. This does not establish Gemini-to-Hermes sending or a permanent receiving agent.

Sources: [Agent Skills](https://geminicli.com/docs/cli/skills/) and [Managing Agent Skills](https://geminicli.com/docs/cli/using-agent-skills/).

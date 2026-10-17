# Grok Bot: first AGX task

Status: xAI Grok Bot identified and its public documentation checked; a live app smoke test is pending. This is the personal Bot product, not the Grok Build coding CLI or the Grok model API.

## Give the Bot the public source

Open a Bot conversation and provide an accessible repository link or complete public source folder. Preserve the branch/revision containing this guide when sharing a link or downloading files. Do not give it only `SKILL.md`: the runnable sample needs the bundled scripts and lockfile. No account connector, private project upload or saved skill is needed for this fictional demo.

Paste:

> Help me complete my first AGX task using the source I provided. Locate the `agx-get-started` skill, read its `SKILL.md`, and follow the default local sample. Guide me through running it in my own terminal: one complete command block, then wait for my actual output and verify the result and cleanup. Distinguish your cloud computer's paths from my computer's paths. Keep my existing agent keys and settings unchanged. Report any file-access or permission blocker instead of guessing.

Use the [human guide](../START-HERE.md) and [sample guide](../examples/local-sample.md). Have the user download the complete source to their computer if it exists only on the Bot's cloud computer; give terminal commands for the location the user actually has. A path on the user's Mac is not automatically available in the Bot's cloud filesystem, and a cloud path is not a valid Mac handoff.

Locate `skills/agx-get-started/SKILL.md` in a checkout or `SKILL.md` in the standalone skill folder. Check the sample scripts and lockfile together, then join the quoted directory change, install and run with `&&`. If source access is blocked, hand the user the human-guide link and its download/terminal steps; do not request access to private files or invent successful output. Judge success from the user's actual output, not a run on the Bot's computer.

The first test is guided user-terminal onboarding. Executing the sample on Grok Bot's own cloud computer is a separate test and requires explicit authorization plus its normal tool/network permissions. Do not claim that guided success tested that execution mode or Grok Bot-to-Hermes sending.

## Saving a reusable workflow is optional

xAI documents asking the Bot to save a successful workflow as a skill. Do that only when requested, after the first task succeeds. Review the saved workflow and confirm the actual library entry. Do not claim a `SKILL.md` importer, filesystem location or `grok` installer that has not been verified for Grok Bot. Do not create a routine or background receiver as part of this first-run test.

## Pass criteria

Record the app/build when available, source visibility, machine used for execution, assistance required, and actual `completed: true` / `cleanedUp: true` with `DEMO-1001` / `ready-for-pickup`. Native saved-skill registration is a separate result, not implied by the task completing.

Sources: [Grok Bot](https://docs.x.ai/grok-bot/overview), [computer and apps](https://docs.x.ai/grok-bot/computer-and-apps), and [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

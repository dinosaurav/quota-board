---
name: add-plan
description: Add a new AI subscription plan (or every plan from a new provider) to quota-board's plans/ knowledge base, or find plans that are missing. Use when asked to add a plan, provider or tier.
---

Follow the "Add a plan" section of AGENTS.md at the repository root, and its "Rules for every job" and "Before you hand back" sections.

- Check the plan isn't already there first (`node bin/quota-board.mjs plans <search>`).
- Add every current tier of the provider, not only the one asked for, unless told otherwise.
- Never invent `detect.tiers` strings. Leave them empty without evidence.
- Finish with `npm run check` and `npm test`, then report the new plan ids and anything unconfirmed.

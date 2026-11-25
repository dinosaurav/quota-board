---
name: recheck-plans
description: Re-check quota-board plan files against the providers' current pages (limits, reset rules and conditions, promos, models, quirks) and update plans/*.json. Use when asked to re-check, research or update plans, rules or limits, optionally for one provider.
---

Follow the "Re-check plans" section of AGENTS.md at the repository root, and its "Rules for every job" and "Before you hand back" sections.

- If the user named a provider or plan, do only those files. Otherwise list plan files by `lastVerified`, oldest first, and work through them grouped by provider.
- With many providers, research them in parallel (one subagent per provider, each given the checklist from AGENTS.md and told to edit only that provider's files).
- Finish with `npm run check` and `npm test`, then report per plan what changed with a source link for each change.

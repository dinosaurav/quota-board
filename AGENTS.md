# quota-board: guide for AI agents

quota-board is a zero-dependency Node CLI (Node 22.5+) that shows a user's AI subscriptions: limits, reset rules and their conditions, promos, model access, and live usage read from local logins. The plan facts are community-maintained JSON files, and keeping them current is most of the work.

This file is for agents (Claude Code, Codex, Cursor, Gemini, and others). Humans: [CONTRIBUTING.md](CONTRIBUTING.md) covers the same ground more briefly.

## Pick your job

| You were asked to | Go to |
|---|---|
| "Re-check the plans", "update the rules", "is X still right" | [Re-check plans](#re-check-plans) |
| "Add plan X", "add provider Y", "find plans we're missing" | [Add a plan](#add-a-plan) |
| A provider shows `failed`, or numbers look wrong | [Fix a collector](#fix-a-collector) |
| "N limit(s) not in this plan file" | [New limits](#new-limits) |
| Change the CLI, dashboard or core code | [Code changes](#code-changes) |

Whatever the job, finish with [Before you hand back](#before-you-hand-back).

## Layout

```
plans/<plan-id>.json        one file per plan: the facts (schema/plan.schema.json)
schema/plan.schema.json     field-by-field definition, with descriptions
schema/plan.template.json   starting point for a new plan
docs/PLANS.md               generated list of every plan. Don't edit; CI rebuilds it.
dist/quota-board.mjs        generated single-file edition people run with curl | node. Don't edit; CI rebuilds it.

bin/quota-board.mjs         CLI: commands, flags, progress steps
src/plans.mjs               loads and validates plans (used by the CLI and CI)
src/state.mjs               picks the user's plans (config + detected tiers), builds the board
src/meter.mjs               meter status, pace, reset roll-forward
src/collect.mjs             runs the collectors
src/render/terminal.mjs     terminal output
src/render/html.mjs         dashboard page (web/dashboard.html + web/dashboard.js)
src/serve.mjs               optional localhost server for the dashboard
src/config.mjs              ~/.quota-board/config.json
collectors/lib.mjs          shared helpers: HTTP, read-only sqlite, protobuf, JWT
collectors/providers/*.mjs  one per provider: collect() reads usage, parse() is pure
test/                       node:test tests; test/fixtures/ holds sanitized provider responses
tools/check.mjs             validates plans (CI)
tools/plans-doc.mjs         builds docs/PLANS.md
tools/bundle.mjs            builds dist/quota-board.mjs
```

## Commands

```sh
npm test                          # parser and core tests
npm run check                     # validate every plan file; must print "ok"
npm run build                     # rebuild docs/PLANS.md and dist/quota-board.mjs (CI also does this on main)
node bin/quota-board.mjs doctor   # what each collector finds on this machine
QUOTA_BOARD_HOME="$(mktemp -d)" node bin/quota-board.mjs   # run without touching the user's real config
```

## Rules for every job

1. **Facts live only in `plans/`.** Never hard-code a limit, price, model name or date in code or in the dashboard.
2. **Ids are keys.** Plan ids, meter ids and reset ids are referenced by collectors, tests and users' saved readings. Don't rename one. If you truly must, update every reference in the same change and say so in your report.
3. **Official sources first.** The provider's pricing page, help center, docs, changelog, status page, or an official blog post or social account.
4. **Third-party claims are labelled.** If only a news site, forum, Reddit or a reseller says it:
   - an event gets `"unverified": true` and a `source` URL;
   - a quirk or stipulation ends with "(third-party report, unconfirmed)".
   Never state it as fact.
5. **`lastVerified` means everything.** Set it to today only when you checked every fact in that file. If you checked one fact, leave the date alone.
6. **No personal data in plan files.** A plan describes the plan for everyone. What one user pays, their family-plan setup or their usage goes in their own config, never in `plans/`.
7. **Plain writing.** Plan text is shown to users verbatim. Short, specific sentences: what happens, when, under what condition. No marketing words ("generous", "unlimited*"), no hedging filler. Use the provider's own names for models and features.
8. **No secrets, ever.** Collectors read logins read-only and send them only to that provider's own endpoint. Never print, log, store or put in a fixture a token, cookie, email, account id, user id or org id.
9. **No npm dependencies.**
10. **Don't commit or push unless the person you're working for asked you to.**

## Re-check plans

Work one plan file at a time. Group plans from the same provider: they share pages, and their meter ids must stay consistent.

1. **Read the file and its `sources`.** Open every source URL. Then find the provider's current:
   - pricing page and plan-comparison table
   - usage-limits or rate-limits help article
   - model list and which plans get which models
   - changelog, release notes or blog
   - search for news from the last 60 days: "<provider> usage limits", "<plan> weekly limit", "<provider> promo", "<provider> reset".
2. **Go through this checklist** and fix anything that changed.

   | Field | Check |
   |---|---|
   | `name`, `price`, `status` | Still sold under this name and price? `legacy` = existing subscribers keep it but it's no longer sold. `discontinued` = gone. |
   | `meters[]` | One meter per limit window the provider enforces. `period`, `reset.type`, `reset.rule` (one sentence: when it resets), `reset.stipulations` (what counts toward it, what's shared with other products, exceptions, multipliers like "Fast mode uses limits 2x faster"). |
   | `resets[]` | Spendable resets: promo resets, reset credits, how many and why, `expires`, `howTo`, conditions. Remove expired ones. |
   | `overage` | What happens at the limit. Paid overage, its price, caps, whether it's on by default. |
   | `card.how` | How the limits work, in 2–4 bullets. |
   | `card.ext` | Models from other companies included, and use of the plan in other tools (other IDEs, CLIs, API keys). |
   | `card.quirks` | Anything that surprises people: an env var that silently switches billing, a legacy plan you can't return to, a cache that misreports. |
   | `card.alert` | One urgent line, only while something time-sensitive is happening. Remove it when it's over. |
   | `modelTable` | Models, their costs or multipliers, and which pool they draw from. |
   | `events[]` | Add new dated promos and deadlines. Remove events more than 30 days past (`npm run check` warns). |
   | `detect` | Tier strings. Add one only with evidence of the exact string (see [Detection](#detection)). |
   | `sources[]` | Add pages you used, mark `official` correctly, drop dead links. |

3. **Use live evidence.** If you can run `node bin/quota-board.mjs -v` and a collector shows a limit, reset credit or tier the docs don't mention, it's real for that user. Add it, and say in the stipulation where it came from ("Shown by the usage API; not in the docs").
4. Set `lastVerified` (rule 5) and run `npm run check`.

### Reset types

| `reset.type` | Meaning |
|---|---|
| `rolling-from-first-use` | Window opens at your first use and resets in full when it ends (e.g. 5 hours later). |
| `rolling-weekly` | Seven days from first use. |
| `rolling-5h-until-weekly` | 5-hour windows that stop resetting once the weekly limit is hit. |
| `fixed-weekly-account` | A fixed weekly time assigned per account. |
| `fixed-weekly-utc` | A fixed weekly time for everyone (set `auto: "monday-utc"` if it's Monday 00:00 UTC). |
| `billing-cycle` | On your subscription renewal date. |
| `paid-period` | Lasts as long as the period you bought (credit packs, day passes). |
| `calendar-month` | 1st of each month. |
| `fixed-30d` | Every 30 days from activation. |
| `daily` | Daily (say the time and timezone in `rule`). |
| `unknown` | The provider doesn't say. Say what is known in `rule`. |

## Add a plan

1. **Check it isn't already there:** `node bin/quota-board.mjs plans <search>` or `grep -il "<name>" plans/*.json`.
2. **Copy** `schema/plan.template.json` to `plans/<id>.json`. The id is kebab-case, starts with the provider or product (`copilot-pro-plus`, `kimi-max`) and equals the file name.
3. **Research it** exactly as in [Re-check plans](#re-check-plans) and fill every field. `schema/plan.schema.json` describes each one.
4. **Meter ids.** If the provider already has a collector, reuse the meter ids it emits: grep `collectors/providers/<id>.mjs` and look at that provider's other plans. Otherwise use a new provider prefix (`kiro-month`, `glm-5h`). Ids must be unique within a plan.
5. **Detection.** Only when a collector exists for this provider. See below.
6. Run `npm run check` and `npm test`.

To find plans we're missing: compare `docs/PLANS.md` against each provider's pricing page, then search for AI coding and chat subscriptions with usage limits launched in the last 90 days.

To drop a plan: set `status` to `legacy` (still sold to existing users) or `discontinued`. Delete the file only if it was never real.

### Detection

A plan is auto-detected when its collector reports a tier string listed in `detect.tiers` (exact, case-insensitive) or matching `detect.tierPattern`.

- `node bin/quota-board.mjs doctor` prints the tier string a login reports, e.g. `tier "default_claude_max_5x" -> claude-max-5x`.
- Add a string only from a real login, a sanitized fixture, the provider's open-source client code, or a user's `quota-board report` output. Never guess one from the plan's marketing name.
- No evidence yet? Keep `detect.collector` and leave `tiers` empty. `npm run check` warns about it, and users pick the plan with `quota-board use`.

## Fix a collector

1. Reproduce: `node bin/quota-board.mjs doctor` and `node bin/quota-board.mjs json --only <id>`.
2. Find what changed. For undocumented endpoints, read the provider's open-source client (Codex is open source; others ship readable JS) or its logs for the request it makes for its own usage screen.
3. Save the new response, **sanitized**, to `test/fixtures/<id>-usage.json`. Replace every token, email, id, name and org with placeholders. Keep the numbers and field names.
4. Update `parse()` (pure: response in, result out), add or update the test in `test/collectors.test.mjs`, run `npm test`.
5. Check nothing identifying leaks: `node bin/quota-board.mjs json | grep -iE "email|token|account|user_id|org"` must print nothing.

Collector contract (`collectors/providers/<id>.mjs`):

```js
export const id = 'claude';                    // matches detect.collector in plan files
export const source = 'Where it reads, and whether that is documented';
export async function collect() {              // throws NotConfigured(message, hint) if not signed in
  return {
    detectedTier: 'string or null',
    meters:   { '<meter-id>': { used: 0-100, resetAt: 'ISO', windowSeconds, note?, breakdown? } },
    resets:   { '<reset-id>': { available, usableNow } },
    unmapped: [{ key, used, resetAt }],        // limits in the response that no meter covers
    extras:   { label: 'short string' },
    freshness: 'live' | 'cached'               // optional
  };
}
export function parse(response) { /* pure; tested with a fixture */ }
```

Where to find a usage source, best first: a documented usage API; the endpoint the provider's own app uses for its usage screen, with the login that app stored; local logs or a cached status; none (manual readings, and say so in the meter's `hint`).

Also add a fallback that asks the provider's own tool, when it has a command that reports usage without sending a prompt (`claude -p /usage`, `codex app-server`, `agy -p /usage`). Use `runTool()` from `collectors/lib.mjs`: no shell, so `/usage` isn't rewritten into a path by Git Bash. Before relying on a command, confirm it reports zero turns; a command the tool doesn't recognise becomes a prompt and spends the user's quota. Honour `QUOTA_BOARD_DIRECT=0` by skipping every login-file read.

Rules: open credential files and app databases read-only; never refresh, rotate or write a token; never call any host except the provider's own.

## New limits

When the board says "N limit(s) not in this plan file", a collector saw a limit no meter covers.

1. Find out what it is: the key name, its window length, the provider's docs and recent news.
2. Add a meter to every plan from that provider that has the limit.
3. Map the key to the meter id in the collector's `parse()`, add it to the fixture, run `npm test`.

## Code changes

- Keep the CLI's stdout clean: progress goes to stderr through `step()`; the board and JSON go to stdout.
- Terminal and dashboard share one set of meter rules in `src/meter.mjs`; `src/render/html.mjs` inlines it into the page. Change rules there, and keep that file free of imports (the build refuses otherwise).
- The dashboard must work both as a `file://` snapshot and served by `src/serve.mjs`. Embedded state must stay escaped (see `src/render/html.mjs`).
- Anything written to `~/.quota-board` goes through `writePrivate()` in `src/meta.mjs`.
- Test on Windows paths too: no shell-specific commands, use `node:path`.

## Before you hand back

1. `npm run check` prints `ok`.
2. `npm test` passes.
3. Don't hand-edit `docs/PLANS.md` or `dist/quota-board.mjs`. Running `npm run build` locally is fine but optional; CI rebuilds both on main.
4. Report to the person who asked, per plan: what changed, the source link for each change, anything you marked unconfirmed, and anything you couldn't verify. Mention ids you added.
5. If you're opening a pull request, put the same report in its description.

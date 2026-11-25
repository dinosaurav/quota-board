# Contributing

Thanks for helping. Providers change limits, prices and promos every few weeks, so the most useful contribution is keeping [`plans/`](plans) current. You don't need to write any code for that.

Using an AI agent? Point it at [AGENTS.md](AGENTS.md); it has the full checklist.

## Report something

Run `quota-board report`. It prints your detected tiers and any limits quota-board doesn't know about, with no personal details, plus a link to a prefilled issue. Or open an issue with the **Plan update** or **Usage check failed** template.

## Fix or add a plan

1. Edit `plans/<plan-id>.json`, or copy [`schema/plan.template.json`](schema/plan.template.json) for a new one. [`schema/plan.schema.json`](schema/plan.schema.json) describes every field.
2. Run `npm run check`. It must print `ok`. ([docs/PLANS.md](docs/PLANS.md) and the single-file edition are rebuilt automatically after merge.)
3. Open a pull request with a link for every fact you changed.

Rules:

- **Official sources first.** If only a third-party site says it, mark it: an event gets `"unverified": true` and a `source`; a quirk ends with "(third-party report, unconfirmed)".
- **`lastVerified`** goes to today only if you checked every fact in the file.
- **No personal details.** A plan file describes the plan for everyone. What you personally pay goes in your own config (`quota-board price`).
- **Plain writing.** The text is shown to users as-is. Say what happens, when, and under what condition. No marketing language.
- **Keep ids stable.** Plan, meter and reset ids are keys that collectors and users' saved readings depend on.

### Meters and detection

- A meter is one limit window the provider enforces. `reset.rule` says when it resets; `reset.stipulations` lists the conditions.
- Plans from the same provider share meter ids, so one collector serves all of them. Every Claude plan uses `claude-5h` and `claude-week`, for example.
- `detect.tiers` links a plan to the tier string a collector reports. `quota-board doctor` shows yours. Add a string only when you've seen it; don't guess from the plan name.

## Add or fix a provider check (collector)

Collectors live in `collectors/providers/<id>.mjs`. Each exports `id`, `source`, `collect()` and a pure `parse()`; [AGENTS.md](AGENTS.md#fix-a-collector) has the full contract.

- Read logins read-only. Never refresh or rewrite them.
- Send them only to that provider's own endpoint.
- Return only percentages, reset times, tier names, counts and short notes.
- Throw `NotConfigured(message, hint)` from `collectors/lib.mjs` when the user isn't signed in; the hint says how to sign in.
- Add the response you parsed to `test/fixtures/`, **with every token, email, id and name replaced**, and a test in `test/collectors.test.mjs`.

## Development

```sh
git clone https://github.com/dinosaurav/quota-board && cd quota-board
node bin/quota-board.mjs                               # run from source
npm test                                               # tests
npm run check                                          # validate plan files
npm run build                                          # rebuild docs/PLANS.md and dist/quota-board.mjs
node --input-type=module - < dist/quota-board.mjs      # run the single-file edition
QUOTA_BOARD_HOME="$(mktemp -d)" node bin/quota-board.mjs   # throwaway config
```

Node 22.5+, no dependencies, and we'd like to keep it that way. CI runs the checks and tests on Linux, macOS and Windows.

By contributing you agree your contribution is licensed under the [MIT License](LICENSE).

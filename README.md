# quota-board

**One command, nothing to install: see every AI subscription you pay for.** How much of each limit you've used, when each window resets and on what terms, and which promos are about to end.

Claude, ChatGPT/Codex, Cursor, Google AI (Antigravity), OpenCode and [75 more plans](docs/PLANS.md) from 26 providers. No install, no dependencies, no account, and nothing leaves your machine except calls to each provider's own API.

```
› Loaded 80 plan files
› Checking usage: antigravity, claude, codex, cursor, opencode
›   cursor       live 0.2s
›   claude       live 0.3s
›   codex        live 0.5s
›   antigravity  live 3.2s
› Writing dashboard page

Quota Board  4 plans · $240/mo

Claude Max  Anthropic · $100/mo  live
  5-hour session                    ███░░░░░░░░░░░░░  21%  resets in 3h 0m      on pace
  Weekly, all models                █░░░░░░░░░░░░░░░   9%  resets in 4d 23h     on pace
  Fable weekly allowance            █░░░░░░░░░░░░░░░   6%  resets in 4d 23h     on pace

ChatGPT Pro 100  OpenAI · $100/mo  live
  Codex + Work weekly               ██░░░░░░░░░░░░░░  14%  resets in 2d 17h     on pace
  ↺ Banked Codex resets: 3 held, 0 usable now

Cursor Pro  Cursor · $20/mo  live
  Third-party models pool           ████████░░░░░░░░  49%  resets in 27d 20h    ahead of pace

Coming up
  Nov 30  Cursor: Gemini 4 Carbon intro pricing ends…
  Dec 1   OpenAI: ChatGPT and Codex share one token-based allowance…

Dashboard  file:///home/you/.quota-board/dashboard.html
```

## Why

Every plan meters differently. Some limits roll five hours from your first message, some reset at a fixed time assigned to your account, some only monthly on your billing date. Some plans hand out reset credits you can spend, some count other companies' models against a separate, smaller pool, and promos change the rules every few weeks. quota-board keeps those rules in one place, reads your live usage, and tells you where you stand. It's one file you pipe into Node, so there's no app, menu bar icon or background process.

## Run it

You need [Node.js](https://nodejs.org) 22.5 or newer. Then:

**macOS, Linux, WSL, Git Bash**

```sh
curl -fsSL https://raw.githubusercontent.com/dinosaurav/quota-board/main/dist/quota-board.mjs | node --input-type=module -
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/dinosaurav/quota-board/main/dist/quota-board.mjs | node --input-type=module -
```

That's it. There's no installer and nothing to update: every run fetches the newest version, including the latest plan facts. Add arguments after the dash, for example `… | node --input-type=module - -v`.

[`dist/quota-board.mjs`](dist/quota-board.mjs) is the whole project (code, plan files, dashboard) in one file, rebuilt automatically from this repository. It unpacks itself into `~/.quota-board/cache` the first time a version runs, so later runs start instantly. Read it before you pipe it anywhere: the embedded files are one long line, and the code that unpacks and runs them is the 30 or so lines around it.

**Want a shorter command?** Add an alias:

```sh
alias quota-board='curl -fsSL https://raw.githubusercontent.com/dinosaurav/quota-board/main/dist/quota-board.mjs | node --input-type=module -'   # ~/.bashrc or ~/.zshrc
```

```powershell
function quota-board { irm https://raw.githubusercontent.com/dinosaurav/quota-board/main/dist/quota-board.mjs | node --input-type=module - @args }   # $PROFILE
```

Or run it with `npx github:dinosaurav/quota-board`, or clone the repository and run `node bin/quota-board.mjs`.

## Quick start

```sh
quota-board                      # collect usage, print the board, write the dashboard page
quota-board plans claude         # find plans quota-board knows
quota-board use google-ai-ultra-5x            # fix a wrong detection, or add a plan with no live usage
quota-board price google-ai-ultra-5x 100 "Family plan"   # record what you actually pay
quota-board set cursor-week 40 --reset 3d     # enter a reading by hand
```

The examples use the `quota-board` alias; with the one-liner, put the arguments after the dash. quota-board finds your plans from the logins already on your machine. Plans it can't detect, add with `quota-board use`.

## What it reads

| Provider | Needs | How it asks | Reads |
|---|---|---|---|
| Claude (Pro, Max, Ultra, Team) | Claude Code signed in | Claude's usage endpoint with Claude Code's saved login; if that fails, Claude Code itself (`claude -p /usage`) | 5-hour, weekly and per-model weekly limits |
| ChatGPT / Codex | Codex signed in with ChatGPT (CLI or desktop app) | ChatGPT's usage endpoint with Codex's saved login; if that fails, Codex itself (`codex app-server`) | 5-hour, weekly and monthly limits, reset credits and when they expire |
| Cursor | Cursor app signed in | Cursor's dashboard endpoint with the app's saved login | monthly pools, billing cycle, on-demand status |
| Google AI (Antigravity) | Antigravity CLI (`agy`) signed in | the Antigravity CLI itself (`agy -p /usage`) | Gemini and Claude/GPT quota groups, 5-hour and weekly |
| OpenCode Go | `opencode auth login`, or `OPENCODE_GO_API_KEY` | OpenCode's documented usage API | 5-hour, weekly and monthly |

None of these send a prompt to a model, so checking never uses quota.

Every other plan in [docs/PLANS.md](docs/PLANS.md) works with readings you enter by hand, with `quota-board set` or on the dashboard.

The Claude, Codex and Cursor usage endpoints are undocumented: they're the ones each provider's own app uses for its usage screen. They can change without notice. Claude and Codex then fall back to asking their own tool; Cursor shows `failed` while the rest keep working. Please [open an issue](../../issues/new/choose) either way.

**Rather quota-board never opened a login file?** Set `QUOTA_BOARD_DIRECT=0`. Claude and Codex are then read only by asking Claude Code and Codex themselves, and Cursor isn't checked. Antigravity already works that way (its plan tier then can't be detected, so pick it once with `quota-board use`), and OpenCode uses the key you give it.

## Commands

```
quota-board                 collect live usage, show your board, write the dashboard page
quota-board -v              also show reset rules, breakdowns and extras
quota-board open            same, then open the dashboard page in your browser
quota-board serve           live dashboard at http://127.0.0.1:4477, refreshes every 5 min
quota-board json            the board as JSON, for scripts

quota-board plans [search]  every plan quota-board knows (● = on your board)
quota-board use <id...>     put plans on your board (overrides detection for that provider)
quota-board drop <id...>    take plans off
quota-board price <id> <amount> [note]   record what you actually pay
quota-board set <meter-id> <percent|clear> [--reset 3h|2d|ISO]   enter a reading by hand

quota-board doctor          what each provider check found on this machine
quota-board report          prefilled GitHub issue for a missing plan or limit
quota-board update          git pull, if you run it from a clone
```

| Option | |
|---|---|
| `--cached` | reuse the last collection instead of calling providers again |
| `--only claude,codex` | check only these providers |
| `--no-html` | don't write the dashboard page |
| `-q`, `--quiet` | don't print progress steps (they go to stderr, so pipes get only the board) |
| `--port N`, `--no-open` | for `serve` |

## The dashboard

Every run writes `~/.quota-board/dashboard.html` and prints a link you can click from the terminal. It's a snapshot with your usage built in, so no server runs. It shows:

- each limit, with a marker for where even pace would be
- one-off resets you can spend, with their conditions
- a timeline of promo deadlines
- a card per plan: how its limits work, which outside models it includes, quirks, and what happens at the limit

Readings typed into the file are kept only in that browser. For a page that stays current and saves readings to your config, run `quota-board serve`. It listens on `127.0.0.1` only and rejects requests from other sites.

## Configuration

Your settings live in `~/.quota-board/config.json`. The commands above edit it; you can also edit it by hand.

| Key | |
|---|---|
| `plans` | plan ids always on your board |
| `hide` | plan ids never shown, even when detected |
| `autoDetect` | `false` to show only `plans` |
| `disabledCollectors` | providers never to check, e.g. `["antigravity"]` |
| `prices` | what you pay: `{ "google-ai-ultra-5x": { "amount": 100, "note": "Family plan" } }` |
| `manual` | readings you entered, by meter id |

| Environment variable | |
|---|---|
| `QUOTA_BOARD_HOME` | data folder (default `~/.quota-board`) |
| `QUOTA_BOARD_PORT` | port for `serve` (default 4477) |
| `NO_COLOR` | plain output |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | non-default Claude Code or Codex folders |
| `AGY_PATH`, `CODEX_PATH` | path to the Antigravity CLI or `codex` if quota-board can't find it |
| `QUOTA_BOARD_DIRECT=0` | never open login files; ask the providers' own tools instead (see [What it reads](#what-it-reads)) |
| `OPENCODE_GO_API_KEY` | OpenCode Go key, if not signed in with `opencode auth login` |

## Privacy

- Logins are read from your machine, read-only, and sent only to that provider's own API. quota-board never refreshes or rewrites them.
- It stores only percentages, reset times, plan names and your settings in `~/.quota-board`, readable only by your user account. No tokens, emails or account ids.
- Nothing is sent anywhere else, and there's no telemetry. `quota-board report` builds an issue for you to read and submit yourself.

See [SECURITY.md](SECURITY.md) for details and how to report a problem.

## Troubleshooting

| You see | Try |
|---|---|
| `not set up` | The hint on that line says how to sign in. Run `quota-board doctor` for every provider at once. |
| `failed · 401` | The login expired. Open that app (Claude Code, Codex, Cursor) once so it refreshes, then run again. |
| `failed` with anything else | The provider changed its API. Run `quota-board report` and open an issue. |
| Wrong plan detected | `quota-board use <right-plan-id>`. If your tier string isn't known, `report` includes it so it can be added. |
| `N limit(s) not in this plan file` | The provider added a limit. `quota-board report` and open an issue. |
| A limit you can't read automatically | `quota-board set <meter-id> <percent> --reset 2d`, or type it on the dashboard. |

## Remove it

Delete `~/.quota-board` (settings, the last readings, the dashboard page and the unpacked cache), and the alias if you added one.

## Contributing

Plans change every few weeks, so the most useful help is keeping [`plans/`](plans) current. Each plan is one JSON file with its sources and the date someone last checked it.

- **Something's wrong or missing:** run `quota-board report` and open an issue, or fix the file and open a pull request.
- **Add a plan or a provider check:** see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Using an AI agent:** point it at [AGENTS.md](AGENTS.md). "Re-check every plan from Anthropic" or "add Windsurf Pro" is enough of a prompt.

## Disclaimer

quota-board is not affiliated with any of the providers it tracks. Plan facts are researched from public pages and may be out of date; each plan file links its sources. Readings come from the providers' own apps' endpoints, and what they report is what you see.

## License

[MIT](LICENSE)

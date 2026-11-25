# Changelog

Plan facts change all the time and aren't listed here; see the git history of `plans/`. This file covers the tool itself.

## 0.1.0 (unreleased)

First public version.

- `quota-board` collects live usage, prints your board with progress steps, and writes a clickable dashboard page.
- Live usage for Claude, ChatGPT/Codex, Cursor, Google Antigravity and OpenCode Go. Claude and Codex fall back to asking Claude Code (`claude -p /usage`) and Codex (`codex app-server`) when the direct check can't run, and `QUOTA_BOARD_DIRECT=0` uses only those.
- 80 plans from 26 providers, with reset rules and their conditions, spendable resets, overage, outside-model access, quirks and dated events.
- Optional live dashboard (`quota-board serve`), manual readings, price overrides.
- Nothing to install: `dist/quota-board.mjs` is the whole app in one file, run with `curl … | node --input-type=module -` (or `irm` on Windows).

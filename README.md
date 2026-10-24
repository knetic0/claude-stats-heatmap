# stats-heatmap

A Claude Code mod that adds a stats pane with a calendar-style heatmap of your activity, GitHub contribution-graph style.

Run `/heatmap` to open it. The pane shows:

- A heatmap of the last weeks (up to 53, as many as the pane is wide), one cell per day, Sunday to Saturday.
- Buttons to switch metric: Messages (`m`), Sessions (`s`), Tool calls (`t`), Tokens (`k`), and Refresh (`r`).
- Totals for the range shown and all time, active days, current and longest streak, busiest day, and top model by tokens.

In the terminal the grid is drawn as colored cells; in the desktop app and VS Code it is an SVG with a tooltip per day.

## Where the numbers come from

- `~/.claude/stats-cache.json`: the daily totals Claude Code computes for its own stats, up to its `lastComputedDate`.
- Days after that (usually today) are counted live from the session transcripts in `~/.claude/projects/`, the same way the cache counts them. Transcripts over 4 MiB are skipped and the pane says how many.

The data refreshes when you run `/heatmap`, press Refresh, and every 5 minutes.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install stats-heatmap --marketplace knetic0/claude-stats-heatmap
```

Answer `y` to add the marketplace, then press Enter to pick the user scope. The mod is active right away, and in every session you start after. Then run `/heatmap`.

From a shell instead:

```sh
claude plugin install stats-heatmap --marketplace knetic0/claude-stats-heatmap
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `knetic0/claude-stats-heatmap`, then Add plugin.

Mods are an early-access Claude Code feature. This one was built and tested on Claude Code 2.1.310.

## Developing

Clone the repository and load your working copy for one session:

```sh
claude --plugin-dir /path/to/claude-stats-heatmap
```

Or for every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-stats-heatmap" } }
```

Check and test it:

```sh
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the command, the pane and its drawing.
- `hooks/stats.ts`: reading the cache and transcripts, the grid, the summary.
- `types/index.d.ts`: the state the pane draws from.

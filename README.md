# ccday

Claude Code usage **for the day, per model**. Minimal take inspired by [ccusage](https://github.com/ccusage/ccusage).

![ccday screenshot](docs/screenshot.png)

## Installation

Requirements: [Node.js](https://nodejs.org) 18 or later. No dependencies to install.

### No install (npx)

```bash
npx geoffroyriou-weqeep/ccday
npx geoffroyriou-weqeep/ccday --date 2026-10-04 --json
```

### Local

```bash
git clone https://github.com/geoffroyriou-weqeep/ccday.git
cd ccday
node ccday.mjs
```

To get a `ccday` command everywhere, pick one:

```bash
# symlink into your PATH (~/.local/bin must be in your PATH)
mkdir -p ~/.local/bin && ln -s "$PWD/ccday.mjs" ~/.local/bin/ccday

# or an alias (zsh)
echo "alias ccday='node $PWD/ccday.mjs'" >> ~/.zshrc && source ~/.zshrc
```

Update: run `git pull` in the cloned folder.

## Usage

```
ccday [--date YYYY-MM-DD] [--json] [--no-cost] [--effort]
```

(or `node ccday.mjs …` / `npx geoffroyriou-weqeep/ccday …`)

Reads `~/.claude/projects/**/*.jsonl` and shows Input / Output / Cache Create / Cache Read / Total / Cost per model. Below the table, a bar chart shows each model's share of tokens.

| Option | Effect |
| --- | --- |
| `--date YYYY-MM-DD` | day to show (default: today) |
| `--json` | JSON output (includes the per-effort breakdown) |
| `--no-cost` | hide costs (skips the price download) |
| `--effort` | adds thinking effort per model: share of messages per level (`low`, `medium`, `high`…) and thinking tokens as a share of output |

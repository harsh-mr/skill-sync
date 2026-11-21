# skill-sync

Local-first CLI & companion Web UI to **discover, consolidate, lint, and sync `SKILL.md` bundles across coding agents** — Claude Code, Cursor, OpenAI Codex CLI, Antigravity, Gemini CLI, GitHub Copilot, Windsurf, OpenCode, Cline, and Roo Code.

## Key Capabilities

- **Auto-discover & consolidate (`scan` / `adopt`):** Scans all installed coding agents, detects duplicates and diverged copies with line diffs, and imports them into `~/.skill-sync/skills/` with automatic backups.
- **Hybrid sync (`symlink` or atomic `copy`):** Use symlinks for local agents and atomic copy mode for cloud agents, Docker devboxes, or Windows — configurable per agent.
- **3-way drift detection:** Tracks synced bundle SHA-256 hashes in `state.json` so edits made directly inside an agent folder are pulled back upstream instead of silently overwritten.
- **Per-agent profiles & context token budget:** Filter which skills sync to each agent via tags/profiles and monitor passive frontmatter token overhead.
- **Built-in linter (`doctor`):** Catches broken YAML frontmatter (with line numbers), naming spec errors, missing `scripts/` or `references/` files, dangling symlinks (`--fix`), and `AGENTS.md` ↔ `CLAUDE.md` drift.
- **Live watcher (`watch`):** Bidirectional debounced file watching across your canonical store and enabled agent directories.
- **Git multi-machine sync (`remote` / `push` / `pull`):** Sync `~/.skill-sync/` across laptops and devboxes via any Git repository while keeping machine-local `state.json` and `.backups/` gitignored.
- **Local companion Web UI (`ui`):** Fast zero-cloud browser workspace (`http://127.0.0.1:4319`) with an Agent × Skill matrix, `SKILL.md` editor, unified diff resolver, doctor audit, and Git sync controls.

## Quickstart

```bash
pnpm install
pnpm build

# 1. Discover existing skills across all installed coding agents
node dist/cli/index.js scan

# 2. Consolidate discovered skills into ~/.skill-sync/skills/
node dist/cli/index.js adopt

# 3. Preview & sync across enabled agents
node dist/cli/index.js sync --dry-run
node dist/cli/index.js sync

# 4. Lint SKILL.md files, broken links, and context token budgets
node dist/cli/index.js doctor

# 5. Watch for live edits across agents or open the local Web UI
node dist/cli/index.js watch
node dist/cli/index.js ui
```

## Supported Agents

| Agent ID | Global Skills Path | Project Skills Path |
| :--- | :--- | :--- |
| `claude-code` | `~/.claude/skills` | `.claude/skills` |
| `cursor` | `~/.cursor/skills` | `.cursor/skills` |
| `codex` | `~/.codex/skills` | `.agents/skills` |
| `antigravity` | `~/.gemini/antigravity/skills` | `.agent/skills` |
| `gemini-cli` | `~/.gemini/skills` | `.gemini/skills` |
| `copilot` | `~/.copilot/skills` | `.github/skills` |
| `windsurf` | `~/.codeium/windsurf/skills` | `.windsurf/skills` |
| `opencode` | `~/.config/opencode/skills` | `.opencode/skills` |
| `cline` | `~/.cline/skills` | `.cline/skills` |
| `roo-code` | `~/.roo/skills` | `.roo/skills` |

Custom agent paths can be configured in `~/.skill-sync/config.json`.

## Commands

- `skill-sync scan [--project | --all] [--agents <list>] [--json]`
- `skill-sync adopt [--project] [--yes] [--strategy newest|skip] [--dry-run] [--json]`
- `skill-sync sync [--project] [--mode symlink|copy] [--dry-run] [--prune] [--conflict skip|canonical|agent] [--bridge-rules] [--json]`
- `skill-sync doctor [--project | --all] [--fix] [--json]`
- `skill-sync status [--project] [--json]`
- `skill-sync watch [--project] [--mode symlink|copy] [--debounce <ms>] [--no-pull]`
- `skill-sync remote [url]`, `skill-sync push [-m <msg>]`, `skill-sync pull [--no-sync-after]`
- `skill-sync ui [--port 4319] [--project] [--no-open]`

## Development

```bash
pnpm typecheck
pnpm build
pnpm test
```

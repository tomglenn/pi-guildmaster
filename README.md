# Guildmaster for Pi

An opinionated multi-agent development workflow built on top of [Pi](https://pi.dev).
**Pi is the harness; Guildmaster is the workflow.**

You talk to a single **Guildmaster**. It does small things itself, delegates
bounded questions to specialists, and hands substantial work to background
**parties** of specialist agents — so your main context stays light and you never
have to wrangle agents by hand.

---

## What it is

Guildmaster adds a few concepts on top of Pi:

- **Guildmaster** — the primary agent you chat with. It decides the cheapest way
  to get each turn done: answer directly, consult one specialist, or start a Quest.
- **Guildmates** — a roster of specialist agents, each with a persona, a model, and
  a **capability tier** that structurally limits what it can do (a read-only agent
  simply has no write or shell tools).
- **Consult** — one bounded, read-only investigation delegated to a single
  Guildmate. Runs inline and returns a concise, evidence-backed result.
- **Quest** — substantial work run in the **background** by a **Party Leader** that
  composes a party of Guildmates. Returns immediately; you keep working. Its
  transcript never enters your context — only the final report does.
- **Approvals** — anything that touches the outside world (pushing a branch,
  posting a PR review) is **parked for your approval**, never auto-done, and never
  blocks unrelated work.

Everything runs through Pi's public extension and SDK surface — Guildmaster does
not patch Pi internals.

---

## Requirements

- [Pi](https://pi.dev) installed (`pi`).
- Authentication configured for whatever model providers your roster uses
  (defaults use Anthropic; the adversarial reviewer uses an OpenAI-family model).
- [`gh`](https://cli.github.com/) authenticated (`gh auth login`) if you want the
  PR-review flow.

---

## Install

**For development** (symlinks `src/` into Pi's extension dir; supports `/reload`):

```bash
git clone git@github.com:tomglenn/pi-guildmaster.git
cd pi-guildmaster
./scripts/dev-install.sh
```

**As a package:**

```bash
pi install /absolute/path/to/pi-guildmaster
```

Start `pi` and run `/guild` to confirm the roster loaded. After editing `src/`,
run `/reload` in Pi. (Note: `/reload` and `/new` cancel any in-flight Quests.)

---

## Using it

Natural language is the primary interface. Just tell the Guildmaster what you want:

> "Where is auth handled in this repo?" → a quick **Consult**.

> "Investigate the flaky checkout test and report back." → a background **Quest**.

> "Implement X, then review it." → a write Quest (isolated worktree → branch →
> draft PR; your checkout is never touched).

> "Review PR 1905 on the pathfinder app." → a **review party** (see below).

Work is tracked on the always-on **Guild board** above/below your input: active
parties with live per-member status, pending approvals, and finished Quests that
persist until you turn them in — colour-coded so nothing is missed while you
multitask.

### Reviewing a pull request

A review is a party, not a single agent:

1. The **envoy** (the only agent that talks to GitHub, through a policy-gated
   shell) fetches the PR.
2. Specialists review in parallel — correctness (**scout**/**delver**), security
   (**warden**), adversarial (**inquisitor**).
3. **Scribe** writes the human-facing review.
4. The Quest **pauses for your approval**: `/approve` to have the envoy post it,
   or leave it as a draft.

`gh pr merge` is always refused, and a suspected security fix is blocked from
auto-posting.

---

## Commands

Commands are introspection and power-user controls — never required ceremony.

| Command | Purpose |
|---|---|
| `/guild` | Show the roster and configured model aliases |
| `/guildmaster` | Show Guildmaster configuration and status |
| `/party` | Show active party / Quest state |
| `/quests` | Show current and recent Quests |
| `/quest-cancel <id>` | Cancel a running background Quest |
| `/consult <guildmate> <question>` | Consult a Guildmate directly |
| `/approvals` · `/approve <id>` · `/deny <id>` | List / resolve parked approvals |
| `/projects` · `/project-remove <id>` | List / remove registered projects |

---

## Projects

Register a project once and target it by name from any directory (resolution is
name-based, not cwd-based). Projects can span multiple repos.

```
"Register my pathfinder project — the app, backend and RFC repos in ~/projects."
```

Consults and Quests then take a `project` (and `repo` for multi-repo projects).
You can also set per-project model overrides and standing instructions.

---

## Configuration

On first use, Guildmaster seeds a durable, user-owned copy of the guild into
`~/.pi/agent/guildmaster/`:

```
guild/
├── config.json      # model aliases + orchestrator models
├── guildmaster.md   # Guildmaster orchestrator prompt
├── party-leader.md  # Party Leader prompt
└── roster/          # one markdown persona per Guildmate
```

Edit these freely — upgrades never overwrite your copy. Models are chosen via
aliases in `config.json`:

| alias | default |
|---|---|
| `fast` | `anthropic/claude-haiku-4-5` |
| `capable` | `anthropic/claude-sonnet-4-5` |
| `reasoning` | `anthropic/claude-opus-4-5` |
| `adversarial` | `openai-codex/gpt-5.5` |
| `coding` | `anthropic/claude-sonnet-4-5` |

Each Guildmate references an alias or an explicit `provider/model`, so you get
per-agent model diversity (the adversarial reviewer deliberately runs on a
different model family).

---

## The roster

| Guildmate | Tier | Role |
|---|---|---|
| **scout** | read-only | Fast, broad reconnaissance |
| **delver** | read-only | Narrow, exhaustive deep tracing |
| **architect** | read-only | Plans, not code |
| **warden** | read-only | Security hunting |
| **inquisitor** | read-only | Adversarial review (different model family) |
| **scribe** | write | Human-facing synthesis / final write-ups |
| **smith** | write | Implementation (in an isolated worktree) |
| **runner** | exec | Builds and tests |
| **envoy** | envoy | The party's only contact with GitHub (gated shell) |

Capability tiers are enforced **structurally** by the tools each agent is given —
not by prompting.

---

## Safety model

- **Structural capability tiers** — read-only agents have no write/exec/GitHub
  tools at all.
- **Write isolation** — write Quests run in a dedicated git worktree on a branch;
  your working checkout is never touched and nothing is pushed without approval.
  (An opt-in in-place mode exists for fast iteration on a clean tree.)
- **Parked approvals** — pushing a branch or posting a review needs your
  `/approve`; a pending approval never blocks other party work.
- **Operation-aware GitHub policy** — `gh pr view/diff` is a read; `gh pr review`
  needs approval; `gh pr merge` is refused. Suspected security fixes are held back
  from auto-posting.
- **Host shell gate** — the main Guildmaster agent's `bash` tool is gated to require
  approval for destructive operations (`gh pr close --delete-branch`, `git push --force`,
  `rm -rf`, `git reset --hard`, branch deletion, etc.) and remote mutations
  (`git push`, `gh pr create`, etc.). Child agents remain structurally sandboxed
  (no bash tool at all). Read-only commands pass freely.

---

## Contributing

Guildmaster is TypeScript, run directly by Pi (no build step for local dev).

```bash
./scripts/dev-install.sh      # symlink into ~/.pi/agent/extensions
# edit src/…
# in Pi: /reload
```

Before opening a PR:

- **Install dev deps once:** `npm install` (pulls the `@earendil-works/*` type
  declarations + `typescript` so the typecheck is authoritative).
- **Type-check:** `npm run typecheck`. This also runs in CI on every push and PR
  (`.github/workflows/ci.yml`), so type errors can't reach `main`.
- Keep changes focused and match the existing style (tabs, small modules,
  doc-commented files).
- Commits use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`…).

### Project layout

```
src/
├── index.ts             # extension entry: wires tools, commands, board, persona
├── quest-tool.ts        # quest / quest_status / quest_dismiss / quest_turn_in
├── consult.ts           # consult tool
├── status.ts            # the Guild status board (widget + cards)
├── capabilities.ts      # tier → tool allowlists
├── roster.ts            # roster loading + seeding
├── config.ts            # model aliases + resolution
├── orchestration/       # party leader, quest lifecycle, approvals, PR raising
├── execution/           # child-agent runner, git worktree isolation, gh policy + gated shell
├── persistence/         # quest + project stores (JSON on disk)
└── assets/guild/        # bundled default roster + prompts (seeded on first use)
```

---

## License

MIT.

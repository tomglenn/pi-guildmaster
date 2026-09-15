# Guildmaster for Pi

An opinionated multi-agent development workflow built on top of [Pi](https://pi.dev).
Pi is the harness; Guildmaster is the workflow.

Guildmaster adds a Guildmaster orchestrator, a roster of specialist **Guildmates**,
lightweight synchronous **Consults**, asynchronous **Quests** coordinated by a
**Party Leader**, per-agent model diversity, real capability boundaries, and
asynchronous human approval — all through Pi's public extension and SDK surface.

## Status

Built vertically, milestone by milestone.

- [x] **M1 — Extension skeleton**: package, config, durable roster seeding,
      status commands, native TUI cards, dev/reload workflow.
- [x] **M2 — One Guildmate (Scout)**: isolated in-process child agent with
      structurally read-only tools, independent context, concise return.
- [x] **M3 — Consult primitive**: generic across read-only Guildmates, declarative
      roster. Predictably bounded by a deterministic **step budget** with a graceful
      wrap-up at the cap (wall-clock is only a hang backstop). Verified Scout, Delver, Warden.
- [x] **M4 — Multi-provider**: per-Guildmate provider proven — Delver on
      `anthropic/claude-sonnet-4-5` produced a conclusion, Inquisitor on
      `openai-codex/gpt-5.5` adversarially reviewed it. Clean plain-text cross-family handoff.
- [x] **M5 — Quest lifecycle + persistence**: six states, per-Quest JSON outside
      Pi's session store, cancellation, and the reality invariant (no `completed`
      without a report). All transitions verified.
- [x] **M6 — Party Leader**: orchestrator-tier agent whose only tool is `dispatch`,
      dynamically composing a Party of read-only specialists. Verified live
      (Scout → Delver → synthesis) with a persisted final report.
- [x] **M7 — Mixed-model adversarial Party**: within one Party, Anthropic specialists
      produce conclusions and Inquisitor (`openai-codex/gpt-5.5`) challenges them; clean
      plain-text cross-provider handoff. Final report extracted structurally (no preamble).
- [x] **M8 — Write isolation**: write-Quests run in a git worktree; Smith implements,
      Runner verifies, and the branch is committed + a draft PR is composed — the user's
      checkout is untouched and nothing is pushed. Verified live (real change + `node` verification).
- [x] **M9 — Asynchronous approval**: parked (non-blocking) approvals — a pending
      approval never destroys unrelated party work. Operation-aware git/gh policy
      (view=read, push/create=approval, merge=refused). Gated draft-PR raise, security-fix
      and grafana first-party guards. Verified against the prototype's failure mode.
- [x] **Projects P1 (multi-repo)**: named registry resolved by name/alias from ANY
      directory (not cwd). Persona + project list injected each turn; `consult`/`quest`
      take `project`/`repo`; Parties investigate across a project's repos; Quests scoped
      per project. Verified live on a two-repo project.
- [x] **Projects P2 (management + customization)**: `update_project` / `remove_project`
      tools + `/project-remove`; per-project model-alias overrides and standing
      `instructions`, layered over the global config. Verified.
- [x] **Projects P3 (cross-repo writes)**: one Quest changes several repos — per-repo
      worktrees/branches, per-repo commits, and per-repo **independently approval-gated**,
      cross-linked draft PRs (never merged). Verified live across two repos.
- [~] **M10 — Daily use**: Quests now run in the BACKGROUND (Guildmaster stays free,
      its context stays light), surfaced by an always-on **Guild status board** (widget +
      footer + transition toasts) plus `quest_status` for on-demand detail. Remaining M10
      work is adoption/observation, not building.

## Install (development)

```bash
./scripts/dev-install.sh
```

This symlinks `src/` into `~/.pi/agent/extensions/guildmaster`. Start `pi` and run
`/guild`. After editing `src/`, run `/reload` in Pi.

## Install (as a package)

```bash
pi install /absolute/path/to/guildmaster
```

## Commands

| Command | Purpose |
|---|---|
| `/guild` | Show the roster and configured model aliases |
| `/guildmaster` | Show Guildmaster configuration and status |
| `/party` | Show active Party / Quest state |
| `/quests` | Show current and recent Quests |
| `/consult <guildmate> <question>` | Directly consult a Guildmate (power user) |

Natural language remains the primary interface; commands are introspection and
power-user controls, never required ceremony.

## Configuration

On first use, Guildmaster seeds a durable, user-owned copy of the guild into:

```
~/.pi/agent/guildmaster/guild/
├── config.json          # model aliases + orchestrator models
├── guildmaster.md       # Guildmaster orchestrator prompt
├── party-leader.md      # Party Leader prompt
└── roster/
    ├── scout.md  delver.md  architect.md  warden.md
    ├── inquisitor.md  smith.md  runner.md  scribe.md
```

Edit these freely. Upgrades never overwrite your copy. Model diversity is
configured via aliases in `config.json` (`fast`, `capable`, `reasoning`,
`adversarial`, `coding`); each Guildmate references an alias or an explicit
`provider/model`.

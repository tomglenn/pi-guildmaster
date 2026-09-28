# Interactive Quests: pause, ask, huddle

Status: Stage 1 + Stage 2 IMPLEMENTED · V2 tear-down/reseed durability still future

## Implementation status

**Built (Stage 2) — the huddle foreground handshake, tested, 156 tests green:**
- `huddle` request kind: a running party raises a `request_user` call with kind
  `huddle` (artifact = a draft, e.g. a plan). It parks and the Quest goes
  `awaiting-input`. (`src/orchestration/approvals.ts`, `src/orchestration/party-leader.ts`)
- Foreground handshake tools for the Guildmaster:
  `quest_huddle` (pick up the pending huddle — loads the topic + artifact so the
  Guildmaster can work through it WITH the user, editing the artifact file over as
  many rounds as needed) and `quest_resume` (settle it: unpark the party with the
  edited artifact as authoritative, or `proceed:false` to abandon).
  (`src/huddle-tool.ts`, registered in `src/index.ts`)
- `plan-implement` recipe: understand → huddle on the plan → implement → self-review
  → `review-artifact` sense-check → draft PR. (`src/orchestration/recipes.ts`)
- Board + inbox + desktop notifications treat a huddle as "ask me to pick it up"
  rather than a one-command answer. (`src/status.ts`, `src/approvals-ui.ts`)
- Tests: `tests/huddle.test.ts`.

**Durability note:** the huddle is currently *process-alive* (the party stays
parked, retaining its planning context to implement afterwards) — the same
tradeoff as Stage 1. This is actually desirable for a single-run plan→implement.
True V2 tear-down + reseed (survive a pi restart / multi-day wait by disposing
the party and rehydrating a fresh one from the artifact) remains the one
unbuilt piece.

**Built (Stage 1) — tested, typechecks:**
- Typed request inbox: `ApprovalManager` now parks typed `UserRequest`s
  (`approve` / `choose` / `answer` / `review-artifact`) and resolves structured
  `UserAnswer`s via `ask()`; the boolean `request()` is preserved as a wrapper so
  the envoy shell and review gate are unchanged. (`src/orchestration/approvals.ts`)
- `awaiting-input` quest state + `QuestManager.transition()` for mid-run pauses.
  (`src/persistence/quest-store.ts`, `src/orchestration/quest.ts`)
- `request_user` tool on the Party Leader: any running party can pause, ask, and
  resume with the answer; state flips running ↔ awaiting-input around each gate.
  (`src/orchestration/party-leader.ts`, wired in `src/quest-tool.ts`)
- PR review is now an EDITABLE `review-artifact`: the drafted review is written to
  `review.md`, the user reads/edits it and only their approval posts the edited
  file. (`src/quest-tool.ts`)
- Terminal inbox: `/inbox` (+ `/approvals` alias), `/approve`, `/deny`, `/choose`,
  `/answer`, `/review`. (`src/approvals-ui.ts`)
- Best-effort desktop notifications on every new request (macOS/Linux, never a
  browser). (`src/execution/notify-desktop.ts`, wired in `src/status.ts`)
- Board + `/quests` reflect the paused states.
- Tests: `tests/requests.test.ts`.

**Not yet built (Stage 2):** the `huddle` foreground handshake, recipes as gated
phase sequences (`phase`/`cursor` on the record), and V2 tear-down + reseed
durability. These build directly on the Stage 1 primitive below.

---

Original design follows.

Status: proposal / design
Author: Guildmaster design session
Scope: make quests able to *wait on the user mid-run* without turning the system
into a rigid workflow engine.

## Problem

Today a quest is a single uninterruptible async run of an in-memory party. It
either runs to completion or parks on a boolean approval promise that only
survives while the pi process is alive (`ApprovalManager.request()` in
`src/orchestration/approvals.ts`, awaited from `src/quest-tool.ts`). The party's
entire context lives in memory and is discarded on `dispose()`
(`SessionManager.inMemory()` in `src/execution/child-agent.ts`).

Real workflows are not fire-and-forget. The user often needs to:

1. **Plan → collaborate/iterate → approve → implement → sense-check → push.**
2. **Review a PR and actually read/edit the review before it posts** — not just
   a blind approve/deny.

Neither is expressible now, for two concrete reasons:

- **No object can *wait on the user*.** A quest finishes or it doesn't; "pause
  here and ask me" is not representable.
- **No inbox / notification.** Even if it could wait, the user would not know.

## Design principles

1. **Primitives, not process.** Build a small set of composable capabilities.
   Do *not* build a rigid multi-phase engine as the mandatory path.
2. **The artifact is the checkpoint.** Every pause point converges on a durable
   file on disk (`plan.md`, `review.md`, a diff). Durability comes from the
   artifact, not from serialising an agent's mind.
3. **Conversation is a foreground activity.** Background parties never host a
   real-time discussion. When discussion is needed, the quest *pauses and hands
   the conversation up to the Guildmaster (foreground)*, then reclaims control.
4. **Structured workflows are opt-in sugar.** "Plan→implement→review→push" is a
   *recipe* layered on the primitives — reached for when repeatable, ignored
   when the work is bespoke. Hand-wrangled distinct quests stay first-class.
5. **Non-committal ordering.** If we build the primitives and never want the
   engine, we lose nothing; the manual workflow is simply much better.

## What we are NOT building (yet)

- A rigid phase/state-machine engine that owns and enforces a fixed sequence.
- Serialisation/rehydration of live agent session transcripts.
- Resident parties you converse with directly (foreground/background inversion).
- A browser-based report UI. Everything surfaces in the terminal + a desktop
  notification.

---

## Core primitive: a quest that can pause, ask, and resume

### 1. New quest state + request model

Extend the quest record (`src/persistence/quest-store.ts`, `QuestRecord`):

- Add state `awaiting-input` (alongside existing `awaiting-approval`; keep the
  latter as the boolean special-case or fold it in — see Migration).
- Add `pending?: UserRequest` — the thing the quest is currently blocked on.
- Add `phase?: string` and optional `cursor` for recipe-driven quests (unused by
  bespoke quests).

Generalise `ApprovalManager` (`src/orchestration/approvals.ts`) from
boolean-only into a **typed request inbox**. A `UserRequest` has a `kind`:

| kind | payload | user answers with |
|------|---------|-------------------|
| `approve` | title, description, operation | approve / deny (today's behaviour) |
| `choose` | prompt, options[] | one (or many) of the options |
| `answer` | prompt(s) | free text (one or batched, Lavish-style) |
| `review-artifact` | path to a file (e.g. `review.md`, `plan.md`) | edit-in-place + approve, or send back with notes |
| `huddle` | topic, artifact path | *promote to foreground* (see below) |

Keep the existing parked-promise mechanics: persist the request to
`~/.pi/agent/guildmaster/approvals/<id>.json` (already done), park the resolver
in memory, resolve on user action. The resolver now returns a structured answer,
not just a boolean.

### 2. A tool the party can call mid-run

Add a `request_user` tool available to the Party Leader (and, gated, to members)
in `src/orchestration/party-leader.ts` alongside `dispatch`:

```
request_user({ kind, prompt|title, options?, artifactPath?, operation? })
  -> resolves to the user's structured answer
```

When called:
- Write any draft artifact to the quest scratch/worktree dir
  (`~/.pi/agent/guildmaster/scratch/<id>/` or the worktree) so it is durable.
- Set `record.state = "awaiting-input"`, `record.pending = <request>`, persist.
- Fire a **desktop notification** + surface in the terminal inbox.
- Return the parked promise; the party awaits it (process-alive model — see
  Durability for the tear-down variant).

### 3. The terminal inbox

Extend `src/approvals-ui.ts` + `src/commands.ts` + `src/status.ts`:

- A single **inbox** listing every pending `UserRequest` across quests, each
  showing quest title, kind, and a preview.
- Commands: `/inbox` (list), `/answer <id> ...`, `/choose <id> <option>`,
  `/review <id>` (opens the artifact for edit then approve/send-back). Keep
  `/approve` and `/deny` as sugar over the `approve` kind.
- **Desktop notification** on new request (macOS `osascript`/`terminal-notifier`,
  degrade gracefully). This is the "surface in the terminal, don't ambush me
  with a browser" requirement.
- Answers can be **queued/batched** (Lavish-style): the user works through the
  inbox at their own pace; each resolution unblocks its quest.

---

## Foreground discussion (the `huddle` handshake)

When a gate needs *iteration*, not a one-shot answer, the quest raises a
`huddle` request instead of blocking on a form.

Handshake:
1. Party writes the current artifact (`plan.md`) to disk, raises `huddle`,
   quest goes `awaiting-input`, party is released (torn down — nothing resident).
2. Guildmaster (this foreground thread) is notified there is a huddle. It loads
   the artifact into *its* context and tells the user "let's work on the plan."
3. User + Guildmaster iterate over as many rounds as they like. Guildmaster edits
   the artifact as they converge, and may fire `architect` **consults** for
   heavy specialist thinking during a round.
4. When the user says "settled," the artifact is frozen and the Guildmaster
   **resumes the quest** (spins a fresh party for the next phase seeded with the
   settled artifact).

Why this shape:
- Conversation happens where it already works (foreground), so no input-routing
  into a backgrounded agent and no resident party.
- **Durable by construction**: the anchor is `plan.md` and the transcript is the
  main pi session (already persisted). Interrupt and resume freely.
- A `huddle` can always **degrade to async rounds** (repeated `review-artifact`
  gates) when the user is away from the keyboard.

---

## Optional sugar: recipes as gated sequences

`recipes` already exist (`src/orchestration/recipes.ts`,
`src/orchestration/recipe-loader.ts`). A recipe becomes an *optional* declared
sequence of phases with gates between them, e.g.:

```
plan  --(huddle: settle the plan)-->  implement
      --(review-artifact: sense-check draft PR)-->  push  (approve: push)
```

- Each phase is a normal party run producing a durable artifact.
- Between phases the quest raises the declared `UserRequest` and waits in the
  inbox / huddle.
- The recipe carries `phase`/`cursor` on the record so it can resume.

Crucially this is **discovered, not designed up front**: build the primitives
first, live in "distinct quests with superpowers," and only crystallise a recipe
once the same sequence is hand-run repeatedly. If patterns never emerge, that is
a valid outcome — the work was genuinely bespoke.

---

## Durability: two variants

**V1 — process-alive (ship first).** The party parks on the promise like today's
approval. Simple, reuses existing machinery, works for same-session waits. The
request is persisted, so it is *visible* after restart even though the resolver
is gone (surface as "stale — quest must be re-run/resumed").

**V2 — tear-down + reseed (durable across restarts).** At a gate, the party is
disposed and the *only* state that survives is the artifact + the quest record's
`phase`/`cursor`. Resuming spins a fresh party seeded from the artifact and
brief. This is what makes multi-day waits safe. No session serialisation needed
because the artifact *is* the checkpoint. Recipes (above) are the natural driver
for V2 since they define where the resumable phase boundaries are.

Order: V1 for bespoke quests and the review sense-check; V2 when recipes land.

---

## Concrete first cut (Stage 1)

Highest value, lowest regret — do this first:

1. **Typed request inbox**: generalise `ApprovalManager` to `UserRequest`
   kinds (`approve`, `choose`, `answer`, `review-artifact`), keep boolean
   approve/deny working. (`src/orchestration/approvals.ts`)
2. **`review-artifact` for PR reviews**: review quests write `review.md`, raise a
   `review-artifact` request; the user reads/edits it in the terminal and only
   their approval posts it. Directly solves problem #2.
   (`src/quest-tool.ts` review finalize path)
3. **Inbox UI + desktop notification**: `/inbox`, `/answer`, `/choose`,
   `/review`; notify on new request. (`src/approvals-ui.ts`, `src/commands.ts`,
   `src/status.ts`)
4. **`request_user` tool** on the Party Leader so any quest can pause and ask
   mid-run (V1 process-alive). (`src/orchestration/party-leader.ts`)

## Stage 2

5. **`huddle` handshake**: quest → foreground discussion → resume.
6. **Recipes as gated sequences** + `phase`/`cursor` on the record.
7. **V2 tear-down + reseed** durability at recipe phase boundaries.

## Migration notes

- `awaiting-approval` becomes either a subtype of `awaiting-input` (kind
  `approve`) or is kept and the inbox renders both. Prefer folding into
  `awaiting-input` with `pending.kind = "approve"` to avoid two code paths.
- Existing `/approve` `/deny` stay as aliases so nothing the user types breaks.
- Persisted request JSON gains a `kind` and structured `answer`; old boolean
  records read as `kind: "approve"`.

## Open questions

- Should `request_user` be available to *members* or only the Party Leader?
  (Leaning: Leader only, members ask the Leader, to keep one throat to choke.)
- Notification backend on non-macOS hosts.
- How much of a huddle transcript (if any) should be attached to the next
  phase's seed beyond the settled artifact.

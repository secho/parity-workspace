# Parity workspace — start here

Everything needed to build the Parity demo with Claude Code. Two days, eight milestones.

## First 5 minutes

```bash
cd parity-workspace
git init parity-platform-demo-app && git init parity
export ANTHROPIC_API_KEY=sk-ant-...          # NOT a Max/Pro OAuth token — see docs/SPEC.md §4
claude
```

Then, in Claude Code, press **Shift+Tab** to enter plan mode and paste:

```
Read CLAUDE.md, docs/SPEC.md, docs/MILESTONES.md and docs/SCHEDULE.md in full.
Then plan M0 only. Do not write code yet.
```

## Read in this order

| File | What it is |
|---|---|
| `docs/SCHEDULE.md` | The two-day plan. Read this first. |
| `docs/MILESTONES.md` | M0–M7 with acceptance criteria. The build's checklist. |
| `docs/SPEC.md` | Full specification. The source of truth for scope. |
| `docs/DEMO-SCRIPT.md` | What happens on stage. The build is done when this runs clean. |
| `docs/DECISIONS.md` | Append-only log. Claude Code writes here; so do you. |

## Rules that matter more than they look

1. **One milestone per session.** `/clear` between them. Context carries through the docs, not the conversation.
2. **Plan mode before every milestone.** Read the plan, cut it, then let it run.
3. **`make verify-mN` must be green before the next milestone starts.** No exceptions — an unverified milestone poisons everything downstream.
4. **Branch and PR per milestone.** The git history is demo material, not housekeeping.

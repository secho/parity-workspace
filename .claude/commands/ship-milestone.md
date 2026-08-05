---
description: Verify, review, commit and PR the current milestone
---

For milestone **$1**:

1. Run `make verify-$1`. If it fails, fix and re-run until green. Do not proceed on a red verify.
2. Dispatch the `reviewer` subagent against this milestone. Address only findings in its two allowed categories.
3. Tick the completed checkboxes in `docs/MILESTONES.md`.
4. Append any decisions made during the milestone to `docs/DECISIONS.md`.
5. Commit on branch `milestone/$1` and open a PR into `main` with a body summarising what was built and what the verify asserts.

Then stop and report. Do not begin the next milestone.

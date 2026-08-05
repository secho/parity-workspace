# Parity — build constitution

Read this every session. It is short on purpose.

## What is being built

Two apps that together demonstrate one claim: **an agent can take an opaque stored-procedure estate, make it legible (spec), make it verifiable (oracle), and safely replace a procedure with a service — with proof that behaviour did not change.**

- `parity-platform-demo-app/` — ParityShop: a fake Czech geek e-shop. MS SQL core with 14 stored procedures holding the business logic, a thin Node monolith that invokes them, a minimal React frontend. **This is the thing that gets refactored.**
- `parity/` — the platform. Ingests the estate, runs one agent over it, produces specs and oracles, shadow-runs replacements, opens PRs.

Full scope: `docs/SPEC.md`. Current milestone and acceptance: `docs/MILESTONES.md`.

## Hard rules

1. **Never invent scope.** If `docs/SPEC.md` does not cover it, append a question to `docs/DECISIONS.md` and ask. Do not "improve" the design mid-build.
2. **One milestone at a time.** Work only on the milestone named in the prompt. Do not start the next one.
3. **`make verify-mN` is the definition of done.** Write the verify script as part of the milestone, not after.
4. **No mocks, no stubs, no fake data in the UI.** A single faked screen destroys the credibility of the whole demo. If something cannot be built yet, leave it absent rather than simulated.
5. **Deterministic demo.** Same seed, same traffic, same numbers on every run. If a displayed number moves between runs, that is a bug.

## Language

- Code, identifiers, commits, comments, docs: **English**.
- All user-facing UI copy in both apps: **Czech**.
- Czech engineering register — these stay English inside Czech grammar: `review`, `PR`, `build`, `deploy`, `merge`, `trigger`, `event`, `sandbox`, `guardrails`, `policy`, `skill registry`, `shadow run`, `patch`, `ticket`, `repo`, `audit log`. Czech verbs get Czech endings: *mergnout PR*, *bumpnout závislost*, *spadlý build*. Never translate literally from English — no "vývojová smyčka", no "tovární podlaha".

## Stack (do not deviate)

Node 22 + TypeScript everywhere. Fastify for services. React + Vite for both frontends. MS SQL Server 2022 in Docker for ParityShop's core. Postgres + Drizzle for Parity's own state. Agent = `@anthropic-ai/claude-agent-sdk` with `ANTHROPIC_API_KEY`.

## Commands

```bash
make up            # docker compose up --build
make seed          # schema + procedures + reference data
make traffic       # generate 90 days of synthetic invocation history
make demo-reset    # full reset to pristine pre-demo state (< 2 min)
make verify-mN     # acceptance check for milestone N
```

## Working style

- Plan before editing. Name files and operations, not intentions.
- Commit at every green verify. Branch `milestone/mN`, PR into `main`.
- Append every non-trivial choice to `docs/DECISIONS.md` with one line of reasoning.
- Prefer boring, obvious code. This is a demo that must survive being read on a projector.

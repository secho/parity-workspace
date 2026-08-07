.PHONY: up down remount seed seed-checksum traffic traffic-checksum ingest demo-reset map-estate \
        generate-oracles shadow-db shadow-run implement-service adopt-service service-suite \
        github-token open-pr record-golden replay-check restore-golden load-replay-source \
        reset-procedure \
        verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7

# Waits only for the containers that must exist BEFORE seeding. shop-api's health
# check queries the ParityShop database, which does not exist until `make seed` has
# run — so waiting for it here would deadlock on a cold start.
up:
	docker compose up --build -d
	@echo "waiting for infrastructure..."
	@for c in parityshop-mssql parityshop-mailpit parity-postgres; do \
		printf "  %s" $$c; \
		until [ "$$(docker inspect -f '{{.State.Health.Status}}' $$c 2>/dev/null)" = "healthy" ]; do printf "."; sleep 2; done; \
		echo " healthy"; \
	done

down:
	docker compose down -v

# Re-resolve the source bind mounts after a git operation that recreated the mounted
# directories — `git checkout` of a branch that lacks parity/*/src deletes them, and the
# running containers keep pointing at the deleted inode. The web app goes white ("Failed
# to load url /src/main.tsx") and the API keeps reporting HEALTHY because tsx already has
# the code in memory, so nothing looks wrong until the next process starts. Run this after
# any branch switch.
# pricing-service is in the list for the same reason and is easier to miss: it does not exist
# on any branch before M5, so checking out an earlier one deletes its src and the container
# keeps serving from memory. A shadow run would then replay against whatever the last build
# happened to contain, which is the worst possible way for it to be wrong.
remount:
	docker compose up -d --force-recreate parity-api parity-web pricing-service pricing-service-generated pricing-service-live
	@printf "waiting for parity-api"
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' parity-api 2>/dev/null)" = "healthy" ]; do printf "."; sleep 2; done
	@echo " healthy"
	@docker compose exec -T parity-api ls /app/src >/dev/null 2>&1 && echo "  api mount ok" || { echo "  api mount STILL EMPTY"; exit 1; }
	@docker compose exec -T parity-web ls /app/src >/dev/null 2>&1 && echo "  web mount ok" || { echo "  web mount STILL EMPTY"; exit 1; }
	@docker compose exec -T pricing-service ls /app/src >/dev/null 2>&1 && echo "  pricing mount ok" || { echo "  pricing mount STILL EMPTY"; exit 1; }
	@docker compose exec -T pricing-service-generated ls /app/src >/dev/null 2>&1 && echo "  generated mount ok" || { echo "  generated mount STILL EMPTY"; exit 1; }
	@docker compose exec -T pricing-service-live ls /app/src >/dev/null 2>&1 && echo "  live mount ok" || { echo "  live mount STILL EMPTY"; exit 1; }
	@# The artefact hash both generated instances report has to be the one on disk. A container
	@# serving a stale copy is the M5 failure this whole target exists for, and here it would be
	@# invisible: /health answers `ok` either way, and the shadow run would replay 400 cases
	@# against whichever source the process happened to still have in memory.
	@for d in parity-platform-demo-app/pricing-service-generated/src/*/; do \
	   proc=$$(basename $$d); \
	   [ -f "$$d/.artifact" ] || continue; \
	   disk=$$(cat "$$d/.artifact"); \
	   for port in $${PRICING_SERVICE_GENERATED_PORT:-3301} $${PRICING_SERVICE_LIVE_PORT:-3302}; do \
	     served=$$(curl -sf http://127.0.0.1:$$port/health | python3 -c "import sys,json;print(json.load(sys.stdin).get('artifacts',{}).get('$$proc') or '')"); \
	     [ "$$served" = "$$disk" ] || { echo "  artefact MISMATCH $$proc on $$port: serving $${served:-none}, disk has $$disk"; exit 1; }; \
	   done; \
	   echo "  artefact $$proc $$(echo $$disk | cut -c1-12) ok on both"; \
	 done

seed:
	npm --prefix parity-platform-demo-app/seed install --silent
	npm --prefix parity-platform-demo-app/seed run seed
	@printf "waiting for shop-api"
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' parityshop-api 2>/dev/null)" = "healthy" ]; do printf "."; sleep 2; done
	@printf " healthy\nwaiting for shop-web"
	@until curl -sf http://127.0.0.1:$${SHOP_WEB_PORT:-5180}/ >/dev/null 2>&1; do printf "."; sleep 2; done
	@echo " serving"

# Regenerate the committed determinism checksum. Run only when the seed legitimately
# changes — verify-m0 asserts the seeded data still hashes to this value.
seed-checksum:
	npm --prefix parity-platform-demo-app/seed run checksum

traffic:
	npm --prefix parity-platform-demo-app/traffic install --silent
	npm --prefix parity-platform-demo-app/traffic run traffic

# The database M5 replays against: a restored copy of ParityShop, owned by parity_shadow,
# plus the backup every revert restores. Must run AFTER `make traffic` — the replay cases
# name orders that traffic placed, and a copy taken before them is missing those rows.
shadow-db:
	npm --prefix parity-platform-demo-app/seed install --silent
	npm --prefix parity-platform-demo-app/seed run shadow

# Re-read the estate. Refreshes estate facts — source, line counts, invocation counts,
# the parse and the graphs built from it — without touching analysis.
ingest:
	docker compose exec -T parity-api npx tsx src/cli/ingest.ts

# Back to the state beat 1 of the demo opens on: fourteen procedures listed with real
# invocation counts, nothing analysed, coverage zero. SPEC §8 puts this at M2 rather than
# M7 because it gets used more often than any other command.
#
# Runs inside the container so it needs no host-side env plumbing, and so it talks to the
# same Postgres and the same ParityShop the API does.
demo-reset:
	docker compose exec -T parity-api npx tsx src/cli/reset.ts

verify-m0:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m0

verify-m1:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m1

# Regenerate the committed traffic fingerprint. Run only when the generator legitimately
# changes — verify-m1 asserts the traffic still hashes to this value.
traffic-checksum:
	rm -f scripts/traffic-checksum.json
	VERIFY_FAST=1 npm --prefix scripts run verify-m1
verify-m2:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m2
# 28 live model runs — triage and extract-spec across all fourteen procedures. Separate
# from verify-m3 on purpose: this happens once, the gate stays free to re-run.
map-estate:
	docker compose exec -T parity-api npx tsx src/cli/map-estate.ts

verify-m3:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m3

# One live model run per procedure that has traffic to draw on, then a baseline pass that
# records what the current procedure does and a verify pass that checks it reproduces.
# Separate from verify-m4 for the same reason map-estate is separate from verify-m3.
generate-oracles:
	docker compose exec -T parity-api npx tsx src/cli/generate-oracles.ts

verify-m4:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m4

# Replay captured invocations against the replacement on the restored copy, diff both sides,
# and ask classify-diff about what canonicalisation could not settle. One live model run per
# finding — a handful, not one per difference. Separate from verify-m5 for the same reason
# generate-oracles is separate from verify-m4.
#
# IMPL picks the replacement. `reference` (the default) is M5's hand-written service — the
# positive control, the only implementation that diverges, and therefore the standing proof
# this harness can still find a real behavioural difference. `generated` is the agent's.
#
# Run the reference one FIRST. `latestRunIds` scopes the decision queue to the newest succeeded
# run per procedure, so a reference run after a green one re-fills the queue with findings that
# have already been decided.
# Quoted, every one of them. Unquoted, an empty CASES= collapses out of the argument list and
# IMPL slides into its place — `Number('generated')` is NaN, so the run selects nothing and
# labels itself `reference`. It then reports success, having replayed zero cases.
shadow-run:
	docker compose exec -T parity-api npx tsx src/cli/shadow-run.ts "$(PROC)" "$(CASES)" "$(IMPL)"

verify-m5:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m5

# One live Opus run that writes the replacement. Separate from the gate, like map-estate,
# generate-oracles and shadow-run before it: it spends real money and several minutes, and the
# gate asserts what it persisted.
#
# FEEDBACK_FILE carries what the previous attempt got wrong, so a second attempt is a
# correction rather than a re-roll. A file rather than a make variable: this is prose, it runs
# to paragraphs, and a multi-line make variable is mangled at the make/shell boundary — the
# quoting breaks before the agent ever sees it.
implement-service:
	docker compose exec -T -e PARITY_SERVICE_FEEDBACK="$$(test -n '$(FEEDBACK_FILE)' && cat '$(FEEDBACK_FILE)' || true)" \
		parity-api npx tsx src/cli/implement-service.ts $(PROC)

# Materialise the generated service onto disk. Runs on the HOST on purpose: parity-api has no
# mount into parity-platform-demo-app, because the SDK's built-in Write is not prefixed
# mcp__parity__ and the tier table therefore cannot refuse it. The agent writes rows; this
# writes files.
adopt-service:
	npm --prefix scripts install --silent
	npm --prefix scripts run adopt-service $(PROC)

# The golden suite against a replacement. TARGET=service is the measurement; `reference` and
# `procedure_on_shadow` are the two controls — see src/cli/service-suite.ts.
service-suite:
	docker compose exec -T parity-api npx tsx src/cli/service-suite.ts $(PROC) $(TARGET)

# Take the token from the gh CLI you are already signed in to and put it where compose can
# read it. Nothing is pasted by hand and no credential enters the repository — .env is
# gitignored. Re-runnable: the line is replaced, not appended.
github-token:
	@gh auth token >/dev/null 2>&1 || { echo "gh is not authenticated — run \`gh auth login\`"; exit 1; }
	@touch .env
	@grep -v '^GITHUB_TOKEN=' .env > .env.tmp || true
	@echo "GITHUB_TOKEN=$$(gh auth token)" >> .env.tmp
	@mv .env.tmp .env
	@echo "GITHUB_TOKEN written to .env for $$(gh api user --jq .login)"
	@docker compose up -d parity-api >/dev/null
	@echo "parity-api restarted with the token"

# Assemble the PR. Opening it needs --commit, which the gate never passes: a pull request on a
# public repository is the one act here that demo-reset cannot take back.
#
# PROC=deletion assembles the deletion campaign's PR instead — one change over three procedures,
# so it is named by what it does rather than by which procedure it belongs to. Its files carry
# `contents: null`, which becomes a tree entry with `sha: null`: three removals, nothing added.
open-pr:
	docker compose exec -T parity-api npx tsx src/cli/open-pr.ts $(PROC) $(COMMIT)

verify-m6:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m6
# The recorded golden run: a snapshot of Parity's analysis, which is both what `docs/SPEC.md` §4
# asks a fresh clone to be able to demo from and what replay mode restores. Read-only against the
# live database — it captures, it never clears.
record-golden:
	npm --prefix scripts install --silent
	npm --prefix scripts run record-golden

# Restore that snapshot into a SCRATCH database and compare row for row. Proves the round-trip
# holds before anything relies on it, and never touches the live analysis.
replay-check:
	npm --prefix scripts install --silent
	npm --prefix scripts run replay-check

# Put the recorded analysis back. Clears first, because a data-only restore into populated
# tables collides on every primary key — and that clearing is exactly what demo-reset does,
# which is the point: reset and restore are two halves of one mechanism.
restore-golden:
	npm --prefix scripts install --silent
	npm --prefix scripts run restore-golden

# Build the REPLAY SOURCE: a second Postgres database holding the recorded analysis, which
# `make demo-reset` cannot reach.
#
# This is what makes beat 1 and replay compatible. The recordings ARE the analysis — reset
# truncates agent_runs and agent_steps with everything else — so recordings kept in the live
# database could only ever re-show what was already on the screen. Kept somewhere else, the demo
# can open on an empty estate and still replay every run into it for nothing.
#
# Built from the committed snapshot by the same three commands `replay-check` uses. Re-run it
# after `make record-golden`, and never otherwise: nothing writes to it.
load-replay-source:
	npm --prefix scripts install --silent
	npm --prefix scripts run load-replay-source

# Put ONE procedure back to "nothing analysed yet" and leave the other thirteen alone. This is
# what makes the lane rehearsable: `demo-reset` is all-or-nothing by design, and re-running a
# whole estate's analysis costs roughly $16 and most of an hour.
#
# KEEP_SERVICE=1 leaves the generated service on disk. That is the usual case when rehearsing
# the campaign, because regenerating a service is a live Opus run; without it the directory goes
# too, so the next lane starts from genuinely nothing.
reset-procedure:
	@test -n "$(PROC)" || { echo "usage: make reset-procedure PROC=<name> [KEEP_SERVICE=1]"; exit 1; }
	docker compose exec -T parity-api npx tsx src/cli/reset-procedure.ts "$(PROC)"
	@if [ -z "$(KEEP_SERVICE)" ]; then \
	   rm -rf "parity-platform-demo-app/pricing-service-generated/src/$(PROC)"; \
	   echo "  removed the generated service source (KEEP_SERVICE=1 to keep it)"; \
	 else \
	   echo "  kept the generated service source"; \
	 fi

# M7 acceptance. Spends nothing: every probe here is model-free, the reset and the
# per-procedure reset are exercised inside transactions that are rolled back, and the gate
# asserts the estate's total spend did not move while it ran.
verify-m7:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m7

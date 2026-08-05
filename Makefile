.PHONY: up down seed seed-checksum traffic traffic-checksum ingest demo-reset map-estate \
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
verify-m4:
	@echo "TODO M4 acceptance"; exit 1
verify-m5:
	@echo "TODO M5 acceptance"; exit 1
verify-m6:
	@echo "TODO M6 acceptance"; exit 1
verify-m7:
	@echo "TODO M7 acceptance"; exit 1

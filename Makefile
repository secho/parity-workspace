.PHONY: up down seed seed-checksum traffic demo-reset \
        verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7

up:
	docker compose up --build -d
	@echo "waiting for mssql to report healthy..."
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' parityshop-mssql 2>/dev/null)" = "healthy" ]; do sleep 2; done
	@echo "mssql healthy"

down:
	docker compose down -v

seed:
	npm --prefix parity-platform-demo-app/seed install --silent
	npm --prefix parity-platform-demo-app/seed run seed

# Regenerate the committed determinism checksum. Run only when the seed legitimately
# changes — verify-m0 asserts the seeded data still hashes to this value.
seed-checksum:
	npm --prefix parity-platform-demo-app/seed run checksum

traffic:
	@echo "TODO M1: 90 days of synthetic invocation history"

demo-reset:
	@echo "TODO M2: full reset to pristine pre-demo state, under 120s"

verify-m0:
	npm --prefix scripts install --silent
	npm --prefix scripts run verify-m0

verify-m1:
	@echo "TODO M1 acceptance"; exit 1
verify-m2:
	@echo "TODO M2 acceptance"; exit 1
verify-m3:
	@echo "TODO M3 acceptance"; exit 1
verify-m4:
	@echo "TODO M4 acceptance"; exit 1
verify-m5:
	@echo "TODO M5 acceptance"; exit 1
verify-m6:
	@echo "TODO M6 acceptance"; exit 1
verify-m7:
	@echo "TODO M7 acceptance"; exit 1

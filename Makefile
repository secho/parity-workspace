.PHONY: up down seed traffic demo-reset verify-m0 verify-m1 verify-m2 verify-m3 verify-m4 verify-m5 verify-m6 verify-m7

up:
	docker compose up --build -d

down:
	docker compose down -v

seed:
	@echo "TODO M0: schema + 14 procedures + reference data"

traffic:
	@echo "TODO M1: 90 days of synthetic invocation history"

demo-reset:
	@echo "TODO M2: full reset to pristine pre-demo state, under 120s"

verify-m0:
	@echo "TODO M0 acceptance"; exit 1
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

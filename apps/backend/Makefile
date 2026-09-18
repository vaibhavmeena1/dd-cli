UV ?= uv

.PHONY: install lock lint format format-check test check pre-commit

install:
	$(UV) sync --frozen --all-groups

lock:
	$(UV) lock

lint:
	$(UV) run --frozen ruff check .

format:
	$(UV) run --frozen ruff check --fix .
	$(UV) run --frozen ruff format .

format-check:
	$(UV) run --frozen ruff format --check .

test:
	@files="$$(find . -type f \( -name 'test_*.py' -o -name '*_test.py' \) -not -path './.venv/*' -print -quit)"; \
	if [ -z "$$files" ]; then \
		echo "No tests yet."; \
	else \
		$(UV) run --frozen pytest; \
	fi

check: format-check lint test

pre-commit:
	$(UV) run --frozen pre-commit run --all-files

SHELL := /bin/bash

VERSION ?=
NPM_TAG ?= latest
NPM_ACCESS ?= public
CORE_PACKAGE := @surprisal-io/hyperchart
PI_PACKAGE := @surprisal-io/pi-hyperchart

.PHONY: help release-prepare release-dry-run release-publish release release-gate _require-version _release-clean _confirm-publish _assert-unpublished

help:
	@printf '%s\n' \
	  'Release workflow:' \
	  '  make release-prepare VERSION=0.2.0' \
	  '      Update both package versions, the exact Pi -> core dependency,' \
	  '      lockfile, and README version labels; then run every release gate.' \
	  '  git add ... && git commit -m "release: 0.2.0"' \
	  '  make release-publish VERSION=0.2.0 CONFIRM=publish-0.2.0' \
	  '      Re-run gates and dry-runs, publish core first, verify it, then publish Pi.' \
	  '' \
	  'Optional: NPM_TAG=next NPM_ACCESS=public'

_require-version:
	@if [[ -z "$(VERSION)" ]]; then echo 'VERSION is required, for example VERSION=0.2.0' >&2; exit 2; fi
	@if [[ "$(VERSION)" == *-* && "$(NPM_TAG)" == 'latest' ]]; then echo 'Pre-releases require an explicit non-latest NPM_TAG, for example NPM_TAG=next' >&2; exit 2; fi

_release-clean:
	@node scripts/check-release-clean.mjs

_assert-unpublished:
	@if npm view '$(CORE_PACKAGE)@$(VERSION)' version >/dev/null 2>&1; then echo '$(CORE_PACKAGE)@$(VERSION) already exists' >&2; exit 2; fi
	@if npm view '$(PI_PACKAGE)@$(VERSION)' version >/dev/null 2>&1; then echo '$(PI_PACKAGE)@$(VERSION) already exists' >&2; exit 2; fi

_confirm-publish:
	@if [[ "$(CONFIRM)" != "publish-$(VERSION)" ]]; then echo 'Publishing requires CONFIRM=publish-$(VERSION)' >&2; exit 2; fi

release-gate: _require-version
	@node scripts/set-release-version.mjs --check '$(VERSION)'
	npm run check
	npm run build-storybook
	npm audit --omit=dev

release-dry-run: _require-version
	@node scripts/set-release-version.mjs --check '$(VERSION)'
	npm publish --dry-run --workspace '$(CORE_PACKAGE)'
	npm publish --dry-run --workspace '$(PI_PACKAGE)'

release-prepare: _require-version _release-clean _assert-unpublished
	@node scripts/set-release-version.mjs '$(VERSION)'
	npm run sync:pi-docs
	@$(MAKE) release-gate VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	@$(MAKE) release-dry-run VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	@printf '\nVersion %s is prepared. Review and commit the release changes, then run:\n  make release-publish VERSION=%s CONFIRM=publish-%s NPM_TAG=%s\n' '$(VERSION)' '$(VERSION)' '$(VERSION)' '$(NPM_TAG)'

release-publish: _require-version _release-clean _confirm-publish _assert-unpublished
	@node scripts/set-release-version.mjs --check '$(VERSION)'
	@npm whoami >/dev/null
	@$(MAKE) release-gate VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	@$(MAKE) release-dry-run VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	npm publish --workspace '$(CORE_PACKAGE)' --access '$(NPM_ACCESS)' --tag '$(NPM_TAG)'
	@for attempt in {1..12}; do \
	  actual="$$(npm view '$(CORE_PACKAGE)@$(VERSION)' version 2>/dev/null || true)"; \
	  if [[ "$$actual" == "$(VERSION)" ]]; then exit 0; fi; \
	  sleep 5; \
	done; \
	echo 'Published core version was not visible in the registry' >&2; exit 1
	npm publish --workspace '$(PI_PACKAGE)' --access '$(NPM_ACCESS)' --tag '$(NPM_TAG)'
	@for attempt in {1..12}; do \
	  actual="$$(npm view '$(PI_PACKAGE)@$(VERSION)' version 2>/dev/null || true)"; \
	  if [[ "$$actual" == "$(VERSION)" ]]; then exit 0; fi; \
	  sleep 5; \
	done; \
	echo 'Published Pi version was not visible in the registry' >&2; exit 1
	@printf '\nPublished %s and %s at %s with tag %s. Create the git tag only after final installation verification.\n' '$(CORE_PACKAGE)' '$(PI_PACKAGE)' '$(VERSION)' '$(NPM_TAG)'

release: release-publish

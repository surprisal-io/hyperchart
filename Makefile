SHELL := /bin/bash

VERSION ?=
NPM_TAG ?= latest
NPM_ACCESS ?= public
CORE_PACKAGE := @surprisal/hyperchart
CLAUDE_PACKAGE := @surprisal/claude-hyperchart
PI_PACKAGE := @surprisal/pi-hyperchart

.PHONY: help release-prepare release-dry-run release-publish release-resume release release-gate _require-version _release-clean _confirm-publish _confirm-resume _assert-unpublished

help:
	@printf '%s\n' \
	  'Release workflow:' \
	  '  make release-prepare VERSION=0.2.0' \
	  '      Update versions and run every release gate.' \
	  '  git add ... && git commit -m "release: 0.2.0"' \
	  '  make release-publish VERSION=0.2.0 CONFIRM=publish-0.2.0' \
	  '      Publish core, then Claude, then Pi.' \
	  '  make release-resume VERSION=0.2.0 CONFIRM=resume-0.2.0' \
	  '      Publish the not-yet-published Claude and Pi packages after an interrupted release.' \
	  '' \
	  'Optional: NPM_TAG=next NPM_ACCESS=public'

_require-version:
	@if [[ -z "$(VERSION)" ]]; then echo 'VERSION is required, for example VERSION=0.2.0' >&2; exit 2; fi
	@if [[ "$(VERSION)" == *-* && "$(NPM_TAG)" == 'latest' ]]; then echo 'Pre-releases require an explicit non-latest NPM_TAG, for example NPM_TAG=next' >&2; exit 2; fi

_release-clean:
	@node scripts/check-release-clean.mjs

_assert-unpublished:
	@if npm view '$(CORE_PACKAGE)@$(VERSION)' version >/dev/null 2>&1; then echo '$(CORE_PACKAGE)@$(VERSION) already exists' >&2; exit 2; fi
	@if npm view '$(CLAUDE_PACKAGE)@$(VERSION)' version >/dev/null 2>&1; then echo '$(CLAUDE_PACKAGE)@$(VERSION) already exists' >&2; exit 2; fi
	@if npm view '$(PI_PACKAGE)@$(VERSION)' version >/dev/null 2>&1; then echo '$(PI_PACKAGE)@$(VERSION) already exists' >&2; exit 2; fi

_confirm-publish:
	@if [[ "$(CONFIRM)" != "publish-$(VERSION)" ]]; then echo 'Publishing requires CONFIRM=publish-$(VERSION)' >&2; exit 2; fi

_confirm-resume:
	@if [[ "$(CONFIRM)" != "resume-$(VERSION)" ]]; then echo 'Resuming requires CONFIRM=resume-$(VERSION)' >&2; exit 2; fi

release-gate: _require-version
	@node scripts/set-release-version.mjs --check '$(VERSION)'
	npm run check
	npm run build-storybook
	@node scripts/check-release-audit.mjs

release-dry-run: _require-version
	@node scripts/set-release-version.mjs --check '$(VERSION)'
	npm publish --dry-run --workspace '$(CORE_PACKAGE)'
	npm publish --dry-run --workspace '$(CLAUDE_PACKAGE)'
	npm publish --dry-run --workspace '$(PI_PACKAGE)'

release-prepare: _require-version _release-clean _assert-unpublished
	@node scripts/set-release-version.mjs '$(VERSION)'
	npm run sync:pi-docs
	@$(MAKE) release-gate VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	@$(MAKE) release-dry-run VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	@printf '\nVersion %s is prepared. Review and commit the release changes, then run:\n  make release-publish VERSION=%s CONFIRM=publish-%s NPM_TAG=%s\n' '$(VERSION)' '$(VERSION)' '$(VERSION)' '$(NPM_TAG)'

release-publish: _require-version _release-clean _confirm-publish
	@node scripts/set-release-version.mjs --check '$(VERSION)'
	@npm whoami >/dev/null
	@$(MAKE) release-gate VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	@$(MAKE) release-dry-run VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	npm publish --workspace '$(CORE_PACKAGE)' --access '$(NPM_ACCESS)' --tag '$(NPM_TAG)'
	npm publish --workspace '$(CLAUDE_PACKAGE)' --access '$(NPM_ACCESS)' --tag '$(NPM_TAG)'
	npm publish --workspace '$(PI_PACKAGE)' --access '$(NPM_ACCESS)' --tag '$(NPM_TAG)'
	@printf '\nPublished %s, %s, and %s at %s with tag %s. Create the git tag only after final installation verification.\n' '$(CORE_PACKAGE)' '$(CLAUDE_PACKAGE)' '$(PI_PACKAGE)' '$(VERSION)' '$(NPM_TAG)'

release-resume: _require-version _release-clean _confirm-resume
	@node scripts/set-release-version.mjs --check '$(VERSION)'
	@npm whoami >/dev/null
	@$(MAKE) release-gate VERSION='$(VERSION)' NPM_TAG='$(NPM_TAG)' NPM_ACCESS='$(NPM_ACCESS)'
	@if npm view '$(CORE_PACKAGE)@$(VERSION)' version >/dev/null 2>&1; then true; else echo '$(CORE_PACKAGE)@$(VERSION) is not published; run release-publish instead' >&2; exit 2; fi
	@for pkg in '$(CLAUDE_PACKAGE)' '$(PI_PACKAGE)'; do \
	  if npm view "$$pkg@$(VERSION)" version >/dev/null 2>&1; then \
	    echo "$$pkg@$(VERSION) is already published; skipping"; \
	  else \
	    npm publish --dry-run --workspace "$$pkg" && \
	    npm publish --workspace "$$pkg" --access '$(NPM_ACCESS)' --tag '$(NPM_TAG)' || exit 2; \
	  fi; \
	done
	@printf '\nResumed release %s with tag %s. Create the git tag only after final installation verification.\n' '$(VERSION)' '$(NPM_TAG)'

release: release-publish

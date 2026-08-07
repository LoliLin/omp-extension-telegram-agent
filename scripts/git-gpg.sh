#!/bin/bash
# git GPG wrapper: signs commits non-interactively using the passphrase from .env
# Configured repo-locally via: git config gpg.program <this file>
set -euo pipefail
ENV_FILE="$(git rev-parse --show-toplevel)/.env"
PASS="$(grep -E '^gpg_key_passphrase:' "$ENV_FILE" | head -1 | cut -d: -f2- | sed 's/^ *//;s/ *$//')"
exec gpg --batch --yes --pinentry-mode loopback --passphrase "$PASS" "$@"

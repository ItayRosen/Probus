#!/usr/bin/env bash
set -euo pipefail

# scripts/post-asknetsec-aitools.sh
#
# One-off helper that posts a Probus comment on:
#   r/AskNetsec — "What AI tools do you use in your daily work?"
#   https://www.reddit.com/r/AskNetsec/comments/1sybivt/
#
# Prereqs:
#   pipx install rdt-cli
#   rdt login              # extracts cookies from your browser
#
# Run:
#   bash scripts/post-asknetsec-aitools.sh

if ! command -v rdt >/dev/null 2>&1; then
  echo "rdt not on PATH. Install with: pipx install rdt-cli" >&2
  exit 1
fi

# --- Comment ------------------------------------------------------------------

IFS= read -r -d '' COMMENT <<'EOF' || :
On the "didn't stick" problem — for me the issue with most AI security tools was that they generate findings without confirming any of them, and after the second false-positive flood you stop opening the report. Disclosure: I'm the author of [Probus](https://github.com/etairl/Probus), an open-source vuln scanner that tries to fix this — three agents instead of one, where an analyst flags the dangerous files, a researcher walks the call chain, and an independent QA model has to reproduce a real attack vector before anything becomes a finding. Different niche than the SOC/alert-triage AI most of these threads cover — it's specifically for auditing a repo, not for blue-team workflows. Cheap on open models (~$0.50/file) so you can run it on your own code or on a vendor's before signing off on it. `npm install -g probus && probus scan ./repo` if you want to kick the tires.
EOF

COMMENT="${COMMENT%$'\n'}"

# --- Target -------------------------------------------------------------------

POST_ID="1sybivt"
POST_LABEL='r/AskNetsec — "What AI tools do you use in your daily work?"'
POST_URL="https://www.reddit.com/r/AskNetsec/comments/${POST_ID}/"

# --- Confirm ------------------------------------------------------------------

cat <<MSG
Will post one comment:

  ${POST_LABEL}
  ${POST_URL}

If you're not sure you're authed, run \`rdt status\` first.

MSG

read -r -p "Post? [y/N] " confirm
[[ "$confirm" =~ ^[yY] ]] || { echo "Aborted."; exit 0; }

# --- Post ---------------------------------------------------------------------

echo
echo "Posting to ${POST_LABEL}..."
rdt comment "$POST_ID" "$COMMENT"

echo
echo "Done. Remember to add ${POST_ID} to probus-reddit-radar/state.json."

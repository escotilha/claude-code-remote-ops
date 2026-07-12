#!/usr/bin/env bash
#
# setup-vps.sh — wire ssh-mcp-server to a host you already reach over SSH.
#
# Run this ON a machine that can already `ssh <alias>` to the target (e.g. the
# Mac Mini, which reaches the VPS as `vps-root` over Tailscale). It:
#   1. reads the effective host/user/port/key from `ssh -G <alias>` — no guessing
#   2. optionally captures the host key fingerprint (MITM protection)
#   3. builds the server
#   4. writes a config OUTSIDE the repo (never committed) with a read-only allow-list
#      and fail-closed SFTP (download of /var/log only; upload off)
#   5. prints the exact `claude mcp add` command to register it
#
# Usage:  bash setup-vps.sh [ssh-alias] [profile]
#           ssh-alias : ssh config alias to target       (default: vps-root)
#           profile   : readonly | ops | ops-template    (default: readonly)
#
#         readonly     — status/logs/disk/uptime only (safe default).
#         ops          — readonly PLUS example service lifecycle patterns.
#                        EDIT the ops allow list before production use.
#         ops-template — same as ops but prints a reminder to customize paths.
#
set -euo pipefail

ALIAS="${1:-vps-root}"
PROFILE="${2:-readonly}"
case "$PROFILE" in readonly|ops|ops-template) ;; *)
  echo "profile must be 'readonly', 'ops', or 'ops-template'"
  exit 1
  ;;
esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG_DIR="$HOME/.config/ssh-mcp"
CFG="$CFG_DIR/${ALIAS}.json"
TRANSFER_ROOT="${SSH_MCP_TRANSFER_ROOT:-$HOME/agent-transfers/$ALIAS}"
AUDIT_LOG="${SSH_MCP_AUDIT_LOG:-$HOME/.local/state/ssh-mcp/audit.jsonl}"

echo "==> Resolving '$ALIAS' from ssh config…"
command -v ssh >/dev/null || { echo "ssh not found"; exit 1; }

# Effective connection params, straight from ssh's own resolver.
GCFG="$(ssh -G "$ALIAS")"
HOSTN="$(awk '$1=="hostname"{print $2; exit}' <<<"$GCFG")"
USERN="$(awk '$1=="user"{print $2; exit}'     <<<"$GCFG")"
PORTN="$(awk '$1=="port"{print $2; exit}'     <<<"$GCFG")"

# First IdentityFile that actually exists on disk (ssh -G lists explicit keys first).
KEY=""
while read -r f; do
  f="${f/#\~/$HOME}"
  if [ -f "$f" ]; then KEY="$f"; break; fi
done < <(awk '$1=="identityfile"{print $2}' <<<"$GCFG")

[ -n "$HOSTN" ] || { echo "Could not resolve hostname for '$ALIAS'"; exit 1; }
[ -n "$KEY" ] || { echo "No existing IdentityFile for '$ALIAS'. Add one to ~/.ssh/config or pass a host with a key."; exit 1; }
PORTN="${PORTN:-22}"
# Prefer whatever ssh -G says; do not force root.
USERN="${USERN:-$USER}"

echo "    host=$HOSTN port=$PORTN user=$USERN"
echo "    key =$KEY"

echo "==> Pre-flight: connecting once to confirm the key works…"
if ssh -o BatchMode=yes -o ConnectTimeout=8 "$ALIAS" 'echo ok:$(hostname)'; then
  echo "    SSH reachable."
else
  echo "!!  BatchMode SSH failed. If the key has a passphrase, add \"passphrase\" to the"
  echo "    config below, or load it into ssh-agent. Continuing to write config anyway."
fi

# Host key fingerprint for MITM protection (best-effort).
FINGERPRINT=""
if command -v ssh-keyscan >/dev/null && command -v ssh-keygen >/dev/null; then
  echo "==> Capturing host key fingerprint…"
  SCAN="$(ssh-keyscan -p "$PORTN" -T 5 "$HOSTN" 2>/dev/null || true)"
  if [ -n "$SCAN" ]; then
    # Prefer ed25519 / ecdsa / rsa first line with SHA256
    FINGERPRINT="$(printf '%s\n' "$SCAN" | ssh-keygen -lf - 2>/dev/null | awk '{print $2; exit}')"
    if [ -n "$FINGERPRINT" ]; then
      echo "    hostFingerprint=$FINGERPRINT"
    else
      echo "    (could not parse fingerprint; continuing without)"
    fi
  else
    echo "    (ssh-keyscan failed; continuing without fingerprint — add hostFingerprint later)"
  fi
fi

echo "==> Building server…"
( cd "$HERE" && npm install --silent && npm run build >/dev/null && echo "    build clean" )

# Read-only base — status/logs/disk/uptime, no state changes.
# Prefer full-string anchors where the command has no args.
ALLOW_READONLY='    "^systemctl status ",
    "^systemctl is-active ",
    "^journalctl ",
    "^tail -n [0-9]+ /var/log/",
    "^ls ",
    "^cat /var/log/",
    "^df -h$",
    "^free -m$",
    "^uptime$",
    "^tailscale status$",
    "^ufw status$",
    "^docker ps$"'

# Ops adds tightly-scoped mutations. REPLACE service names/paths for your host.
# The public defaults are generic examples, not a specific product stack.
ALLOW_OPS="$ALLOW_READONLY"',
    "^systemctl (restart|start|stop) [a-zA-Z0-9_.@-]+$",
    "^systemctl status [a-zA-Z0-9_.@-]+$",
    "^bash /opt/YOUR_APP/scripts/deploy\\.sh$",
    "^touch /opt/YOUR_APP/KILLSWITCH$",
    "^rm /opt/YOUR_APP/KILLSWITCH$"'

if [ "$PROFILE" = readonly ]; then
  ALLOW="$ALLOW_READONLY"
else
  ALLOW="$ALLOW_OPS"
fi

if [ -n "$FINGERPRINT" ]; then
  HOST_KEY_JSON=$(printf ',\n      "hostFingerprint": %s,\n      "strictHostKeyChecking": true' \
    "$(printf '%s' "$FINGERPRINT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null \
      || printf '"%s"' "${FINGERPRINT//\"/\\\"}")")
else
  HOST_KEY_JSON=',
      "strictHostKeyChecking": false'
fi

mkdir -p "$TRANSFER_ROOT"
chmod 700 "$TRANSFER_ROOT" 2>/dev/null || true

echo "==> Writing config to $CFG (profile=$PROFILE, outside the repo, chmod 600)…"
mkdir -p "$CFG_DIR"
cat > "$CFG" <<JSON
{
  "defaultConnection": "$ALIAS",
  "defaultTimeoutMs": 30000,
  "includeBuiltinDeny": true,
  "auditLogPath": "$AUDIT_LOG",
  "allow": [
$ALLOW
  ],
  "deny": [
    "rm -rf", "shutdown", "reboot", "poweroff", "halt", "mkfs", "dd if=",
    "ufw reset", "ufw disable",
    "systemctl (stop|disable|mask) ssh",
    "> /etc", "chmod -R", "chown -R"
  ],
  "transfers": {
    "uploadEnabled": false,
    "downloadEnabled": true,
    "remoteAllow": ["^/var/log/"],
    "remoteDeny": ["\\\\.env\$", "id_rsa", "id_ed25519", "\\\\.pem\$"],
    "localRoot": "$TRANSFER_ROOT"
  },
  "connections": {
    "$ALIAS": {
      "host": "$HOSTN",
      "port": $PORTN,
      "username": "$USERN",
      "privateKeyPath": "$KEY",
      "timeoutMs": 30000$HOST_KEY_JSON
    }
  }
}
JSON
chmod 600 "$CFG"

echo ""
echo "==> Done. Register it with Claude Code (user scope so it loads everywhere):"
echo ""
echo "    claude mcp add -s user --transport stdio ssh-mcp -- \\"
echo "      node \"$HERE/dist/index.js\" --config \"$CFG\""
echo ""
echo "Then start a FRESH Claude session (not /mcp reload) and ask it to:"
echo "    ssh_execute  ->  uptime      (on '$ALIAS')"
echo ""
echo "Profile written: $PROFILE"
echo "  SFTP: upload OFF; download only /var/log/* into $TRANSFER_ROOT"
echo "  Audit log: $AUDIT_LOG (JSONL; no keys/stdout; see docs/audit-log.md)"
echo "  Shell metacharacters blocked when allow list is active."
echo "  Built-in deny patterns merged (rm -r/-f, dd, mkfs, shutdown, …)."
if [ -n "$FINGERPRINT" ]; then
  echo "  Host key: $FINGERPRINT (strict)"
else
  echo "  Host key: NOT pinned — add hostFingerprint to $CFG when you can."
fi
if [ "$PROFILE" = readonly ]; then
  echo "  For deploy/restart ops, regenerate:  bash setup-vps.sh $ALIAS ops"
  echo "  Then edit allow patterns so service names/paths match YOUR host."
elif [ "$PROFILE" = ops ] || [ "$PROFILE" = ops-template ]; then
  echo "  Ops template enabled — REPLACE /opt/YOUR_APP and service name patterns"
  echo "  in $CFG before trusting this for production."
  echo "  Back to safe default:  bash setup-vps.sh $ALIAS readonly"
fi
echo "Deny list always wins (and merges with built-ins)."

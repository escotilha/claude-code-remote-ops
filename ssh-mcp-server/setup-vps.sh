#!/usr/bin/env bash
#
# setup-vps.sh — wire ssh-mcp-server to a host you already reach over SSH.
#
# Run this ON a machine that can already `ssh <alias>` to the target (e.g. the
# Mac Mini, which reaches the Contabo VPS as `vps-root` over Tailscale). It:
#   1. reads the effective host/user/port/key from `ssh -G <alias>` — no guessing
#   2. builds the server
#   3. writes a config OUTSIDE the repo (never committed) with a read-only allow-list
#   4. prints the exact `claude mcp add` command to register it
#
# Usage:  bash setup-vps.sh [ssh-alias] [profile]
#           ssh-alias : ssh config alias to target       (default: vps-root)
#           profile   : readonly | ops                   (default: readonly)
#
#         readonly — status/logs/disk/uptime only (safe default).
#         ops      — readonly PLUS scoped service lifecycle + the sanctioned
#                    alice deploy script + KILLSWITCH. VERIFY the alice paths
#                    below match your VPS before trusting them.
set -euo pipefail

ALIAS="${1:-vps-root}"
PROFILE="${2:-readonly}"
case "$PROFILE" in readonly|ops) ;; *) echo "profile must be 'readonly' or 'ops'"; exit 1;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG_DIR="$HOME/.config/ssh-mcp"
CFG="$CFG_DIR/${ALIAS}.json"

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
PORTN="${PORTN:-22}"; USERN="${USERN:-root}"

echo "    host=$HOSTN port=$PORTN user=$USERN"
echo "    key =$KEY"

echo "==> Pre-flight: connecting once to confirm the key works…"
if ssh -o BatchMode=yes -o ConnectTimeout=8 "$ALIAS" 'echo ok:$(hostname)'; then
  echo "    SSH reachable."
else
  echo "!!  BatchMode SSH failed. If the key has a passphrase, add \"passphrase\" to the"
  echo "    config below, or load it into ssh-agent. Continuing to write config anyway."
fi

echo "==> Building server…"
( cd "$HERE" && npm install --silent && npm run build >/dev/null && echo "    build clean" )

# Read-only base — status/logs/disk/uptime, no state changes.
ALLOW_READONLY='    "^systemctl status ",
    "^systemctl is-active ",
    "^journalctl ",
    "^tail -n [0-9]+ /var/log/",
    "^ls ",
    "^cat /var/log/",
    "^df -h",
    "^free -m",
    "^uptime",
    "^tailscale status",
    "^ufw status",
    "^docker ps"'

# Ops adds tightly-scoped mutations grounded in the alice/VPS workflow.
# NOTE: verify the /opt/claudia paths match your box before relying on these.
ALLOW_OPS="$ALLOW_READONLY"',
    "^systemctl (restart|start|stop) alice(\\.service)?$",
    "^systemctl (restart|status) (claudia|paperclip)(\\.service)?$",
    "^bash /opt/claudia/scripts/vps-autoupdate\\.sh$",
    "^touch /opt/claudia/KILLSWITCH$",
    "^rm /opt/claudia/KILLSWITCH$"'

if [ "$PROFILE" = ops ]; then ALLOW="$ALLOW_OPS"; else ALLOW="$ALLOW_READONLY"; fi

echo "==> Writing config to $CFG (profile=$PROFILE, outside the repo, chmod 600)…"
mkdir -p "$CFG_DIR"
cat > "$CFG" <<JSON
{
  "defaultConnection": "$ALIAS",
  "defaultTimeoutMs": 30000,
  "allow": [
$ALLOW
  ],
  "deny": [
    "rm -rf", "shutdown", "reboot", "poweroff", "halt", "mkfs", "dd if=",
    "ufw reset", "ufw disable",
    "systemctl (stop|disable|mask) ssh",
    "> /etc", "chmod -R", "chown -R"
  ],
  "connections": {
    "$ALIAS": {
      "host": "$HOSTN",
      "port": $PORTN,
      "username": "$USERN",
      "privateKeyPath": "$KEY",
      "timeoutMs": 30000
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
if [ "$PROFILE" = readonly ]; then
  echo "  For deploy/restart ops, regenerate:  bash setup-vps.sh $ALIAS ops"
else
  echo "  Ops commands enabled (service lifecycle, deploy script, KILLSWITCH)."
  echo "  Back to safe default:  bash setup-vps.sh $ALIAS readonly"
fi
echo "Deny list always wins (rm -rf, shutdown, ufw disable, stop/disable ssh, …)."

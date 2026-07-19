#!/usr/bin/env bash
# One-shot / managed VPS captcha session:
# Xvfb + Chromium (Playwright build) + x11vnc + noVNC (localhost only)
set -euo pipefail

SITE_URL="${1:-https://api-provider.uling19.com/login}"
SESSION_NAME="${SESSION_NAME:-captcha}"
HOME_DIR="${GROUP_PRICE_FETCHER_HOME:-/var/lib/group-price-fetcher}"
BASE_DIR="${HOME_DIR}/captcha-session/${SESSION_NAME}"
PROFILE_DIR="${BASE_DIR}/chrome-profile"
RUN_DIR="${BASE_DIR}/run"
LOG_DIR="${BASE_DIR}/logs"
BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${HOME_DIR}/ms-playwright}"
DISPLAY_NUM="${DISPLAY_NUM:-91}"
VNC_PORT="${VNC_PORT:-5901}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
SCREEN_GEOM="${SCREEN_GEOM:-1280x720x16}"
# Bind only loopback by default; expose via temporary SSH tunnel / reverse proxy.
BIND_HOST="${BIND_HOST:-127.0.0.1}"

CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "${CHROME_BIN}" ]]; then
  # Prefer full Chromium over headless_shell for Turnstile/UI.
  if compgen -G "${BROWSERS_PATH}/chromium-*/chrome-linux64/chrome" > /dev/null; then
    CHROME_BIN="$(ls -1 ${BROWSERS_PATH}/chromium-*/chrome-linux64/chrome | tail -n1)"
  elif compgen -G "${BROWSERS_PATH}/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell" > /dev/null; then
    CHROME_BIN="$(ls -1 ${BROWSERS_PATH}/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | tail -n1)"
  else
    echo "ERROR: Chromium not found under ${BROWSERS_PATH}" >&2
    exit 1
  fi
fi

mkdir -p "${PROFILE_DIR}" "${RUN_DIR}" "${LOG_DIR}"
export DISPLAY=":${DISPLAY_NUM}"
export HOME="${HOME_DIR}"
export XAUTHORITY="${RUN_DIR}/Xauthority"
export PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_PATH}"

PID_XVFB="${RUN_DIR}/xvfb.pid"
PID_VNC="${RUN_DIR}/x11vnc.pid"
PID_NOVNC="${RUN_DIR}/novnc.pid"
PID_CHROME="${RUN_DIR}/chrome.pid"
STATUS_FILE="${RUN_DIR}/status.json"
NOVNC_WEB="${NOVNC_WEB:-/usr/share/novnc}"

log() { echo "[$(date '+%F %T')] $*" | tee -a "${LOG_DIR}/session.log"; }

is_running() {
  local pidfile="$1"
  [[ -f "${pidfile}" ]] || return 1
  local pid
  pid="$(cat "${pidfile}" 2>/dev/null || true)"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

stop_pidfile() {
  local pidfile="$1"
  local name="$2"
  if is_running "${pidfile}"; then
    local pid
    pid="$(cat "${pidfile}")"
    log "stop ${name} pid=${pid}"
    kill "${pid}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "${pid}" 2>/dev/null || true
  fi
  rm -f "${pidfile}"
}

write_status() {
  local state="$1"
  local extra="${2:-}"
  cat > "${STATUS_FILE}" <<EOF
{
  "state": "${state}",
  "siteUrl": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${SITE_URL}"),
  "display": "${DISPLAY}",
  "vnc": "${BIND_HOST}:${VNC_PORT}",
  "novnc": "http://${BIND_HOST}:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote",
  "profileDir": "${PROFILE_DIR}",
  "chrome": "${CHROME_BIN}",
  "updatedAt": "$(date -Iseconds)",
  "note": ${extra:-null}
}
EOF
}

cmd="${2:-start}"

case "${cmd}" in
  stop)
    stop_pidfile "${PID_CHROME}" chrome
    stop_pidfile "${PID_NOVNC}" novnc
    stop_pidfile "${PID_VNC}" x11vnc
    stop_pidfile "${PID_XVFB}" xvfb
    write_status "stopped"
    log "stopped"
    exit 0
    ;;
  status)
    if [[ -f "${STATUS_FILE}" ]]; then cat "${STATUS_FILE}"; else echo '{"state":"unknown"}'; fi
    exit 0
    ;;
  start)
    ;;
  *)
    echo "Usage: $0 <site-url> [start|stop|status]" >&2
    exit 2
    ;;
esac

# Clean previous session for this name
stop_pidfile "${PID_CHROME}" chrome || true
stop_pidfile "${PID_NOVNC}" novnc || true
stop_pidfile "${PID_VNC}" x11vnc || true
stop_pidfile "${PID_XVFB}" xvfb || true

log "start captcha session url=${SITE_URL}"
log "chrome=${CHROME_BIN}"

# 1) Xvfb
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOM}" -ac -nolisten tcp >"${LOG_DIR}/xvfb.log" 2>&1 &
echo $! > "${PID_XVFB}"
sleep 0.5
if ! is_running "${PID_XVFB}"; then
  log "Xvfb failed"
  write_status "error" '"Xvfb failed"'
  exit 1
fi

# 2) x11vnc (localhost only, no password for loopback one-shot; protect by bind)
x11vnc \
  -display "${DISPLAY}" \
  -rfbport "${VNC_PORT}" \
  -localhost \
  -nopw \
  -shared \
  -forever \
  -noxdamage \
  -cursor arrow \
  -wait 50 \
  -defer 50 \
  -speeds modem \
  -threads \
  -o "${LOG_DIR}/x11vnc.log" \
  >"${LOG_DIR}/x11vnc.out" 2>&1 &
echo $! > "${PID_VNC}"
sleep 0.5
if ! is_running "${PID_VNC}"; then
  log "x11vnc failed"
  write_status "error" '"x11vnc failed"'
  exit 1
fi

# 3) noVNC / websockify
if [[ ! -d "${NOVNC_WEB}" ]]; then
  log "noVNC web dir missing: ${NOVNC_WEB}"
  write_status "error" '"novnc web missing"'
  exit 1
fi
websockify --web="${NOVNC_WEB}" "${BIND_HOST}:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" \
  >"${LOG_DIR}/novnc.log" 2>&1 &
echo $! > "${PID_NOVNC}"
sleep 0.5
if ! is_running "${PID_NOVNC}"; then
  log "novnc/websockify failed"
  write_status "error" '"novnc failed"'
  exit 1
fi

# 4) Chromium on the virtual display
# Keep flags light for 1.6G RAM VPS.
"${CHROME_BIN}" \
  --display="${DISPLAY}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-extensions \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints \
  --renderer-process-limit=2 \
  --js-flags=--max-old-space-size=128 \
  --metrics-recording-only \
  --password-store=basic \
  --window-size=1280,720 \
  --window-position=0,0 \
  "${SITE_URL}" \
  >"${LOG_DIR}/chrome.log" 2>&1 &
echo $! > "${PID_CHROME}"
sleep 1
if ! is_running "${PID_CHROME}"; then
  log "chrome failed; see ${LOG_DIR}/chrome.log"
  write_status "error" '"chrome failed"'
  exit 1
fi

write_status "running" "\"在 noVNC 中完成登录/验证码后，会话会保存在 profileDir\""
log "ready novnc=http://${BIND_HOST}:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote"
echo "READY http://${BIND_HOST}:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote"
echo "PROFILE ${PROFILE_DIR}"
echo "STATUS ${STATUS_FILE}"

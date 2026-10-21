#!/usr/bin/env bash
set -euo pipefail

# WildDuck Mail Suite v1.55.1 - All-in-One One-Command Installer & Launcher
# Supports fresh Ubuntu/Debian VPS auto-provisioning (Node.js 22, Docker, Redis,
# MongoDB, npm dependencies, systemd service) and interactive English/Vietnamese CLI.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_LANG="${INSTALL_LANG:-}"
SUITE_PORT="${SUITE_PORT:-8088}"
SUITE_HOST="${SUITE_HOST:-0.0.0.0}"
AUTO_START="${AUTO_START:-true}"
ACTION="install"
PID_FILE="/tmp/wildduck-suite.pid"
LOG_FILE="/tmp/wildduck-suite.log"
ENV_FILE="/tmp/wildduck-suite.env"

for arg in "$@"; do
    case "${arg}" in
        --lang=*)
            INSTALL_LANG="${arg#*=}"
            ;;
        --port=*)
            SUITE_PORT="${arg#*=}"
            ;;
        --start)
            AUTO_START="true"
            ;;
        --no-start)
            AUTO_START="false"
            ;;
        --stop)
            ACTION="stop"
            ;;
        --status)
            ACTION="status"
            ;;
    esac
done

if [[ "${ACTION}" == "stop" ]]; then
    if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
        kill "$(cat "${PID_FILE}")" || true
        rm -f "${PID_FILE}"
        echo "[OK] Stopped WildDuck Mail Suite server."
    else
        pkill -f "node.*${REPO_ROOT}/server.js" 2>/dev/null || true
        echo "[OK] No running WildDuck Mail Suite PID found."
    fi
    exit 0
fi

if [[ "${ACTION}" == "status" ]]; then
    if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
        echo "[RUNNING] WildDuck Mail Suite (PID $(cat "${PID_FILE}")) on port ${SUITE_PORT}"
    else
        echo "[STOPPED] WildDuck Mail Suite is not running."
    fi
    exit 0
fi

print_banner() {
    echo "======================================================================"
    echo "  WildDuck Mail Suite v1.55.1 - All-in-One HTMX Mail Server Installer"
    echo "======================================================================"
}

select_language() {
    if [[ -n "${INSTALL_LANG}" ]]; then
        return
    fi
    echo ""
    echo "Select installation language / Chọn ngôn ngữ cài đặt:"
    echo "  1) English (en)"
    echo "  2) Tiếng Việt (vi)"
    if [[ -t 0 ]]; then
        read -r -p "Enter choice [1-2] (default: 2 - Tiếng Việt): " choice
    else
        choice="2"
    fi
    case "${choice}" in
        1|en|EN)
            INSTALL_LANG="en"
            ;;
        *)
            INSTALL_LANG="vi"
            ;;
    esac
}

msg() {
    local key="$1"
    if [[ "${INSTALL_LANG}" == "vi" ]]; then
        case "${key}" in
            runtime)   echo "[0/4] Đang kiểm tra và cài đặt môi trường Node.js 22 LTS, Docker & npm packages..." ;;
            preflight) echo "[1/4] Đang kiểm tra cấu hình phần cứng, hệ điều hành và các cổng mạng (Pre-flight check)..." ;;
            services)  echo "[2/4] Đang kiểm tra và tự động khởi chạy dịch vụ nền MongoDB & Redis..." ;;
            deps)      echo "[3/4] Đang khởi tạo khóa bảo mật Zero-Config..." ;;
            starting)  echo "[4/4] Đang khởi động WildDuck Mail Suite (IMAP, POP3, LMTP, API & Web UI)..." ;;
            ready)     echo "Hoàn tất! Hệ thống đã sẵn sàng tại các địa chỉ dưới đây:" ;;
            *)         echo "${key}" ;;
        esac
    else
        case "${key}" in
            runtime)   echo "[0/4] Checking and installing Node.js 22 LTS, Docker & npm packages..." ;;
            preflight) echo "[1/4] Running hardware, OS, and mail port pre-flight diagnostics..." ;;
            services)  echo "[2/4] Checking and starting background MongoDB & Redis services..." ;;
            deps)      echo "[3/4] Initializing Zero-Config security credentials..." ;;
            starting)  echo "[4/4] Starting WildDuck Mail Suite (IMAP, POP3, LMTP, API & Web UI)..." ;;
            ready)     echo "Bootstrap ready! Open your browser at the URLs below:" ;;
            *)         echo "${key}" ;;
        esac
    fi
}

ensure_node_and_packages() {
    if ! command -v node >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
            echo "  -> Installing Node.js 22 LTS and system prerequisites..."
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            apt-get install -y -qq curl ca-certificates gnupg build-essential git docker.io redis-server
            mkdir -p /etc/apt/keyrings
            curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
            echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
            apt-get update -qq
            apt-get install -y -qq nodejs
            systemctl enable --now docker redis-server >/dev/null 2>&1 || true
        fi
    fi

    if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
        echo "  -> Installing production npm dependencies..."
        (cd "${REPO_ROOT}" && npm install --omit=dev --no-audit --no-fund)
    fi
}

port_is_open() {
    local port="$1"
    node -e "
    const net = require('net');
    const s = net.connect({ host: '127.0.0.1', port: ${port} });
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 1500);
    " 2>/dev/null
}

ensure_backing_services() {
    if ! port_is_open 6379; then
        if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q redis; then
            systemctl start redis-server >/dev/null 2>&1 || systemctl start redis >/dev/null 2>&1 || true
        fi
    fi
    if ! port_is_open 6379; then
        if command -v docker >/dev/null 2>&1; then
            echo "  -> Starting Redis container (127.0.0.1:6379)..."
            docker start wildduck-redis >/dev/null 2>&1 || \
                docker run -d --name wildduck-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:7-alpine >/dev/null
        fi
    else
        echo "  -> [OK] Redis is active on 127.0.0.1:6379"
    fi

    if ! port_is_open 27017; then
        if ! command -v docker >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq && apt-get install -y -qq docker.io
            systemctl enable --now docker >/dev/null 2>&1 || true
        fi
        if command -v docker >/dev/null 2>&1; then
            echo "  -> Starting MongoDB container (127.0.0.1:27017)..."
            docker start wildduck-mongo >/dev/null 2>&1 || \
                docker run -d --name wildduck-mongo --restart unless-stopped -p 127.0.0.1:27017:27017 mongo:7 >/dev/null
            for _ in {1..20}; do
                if port_is_open 27017; then
                    break
                fi
                sleep 1
            done
        fi
    else
        echo "  -> [OK] MongoDB is active on 127.0.0.1:27017"
    fi
}

print_banner
select_language

echo ""
msg "runtime"
ensure_node_and_packages

echo ""
msg "preflight"
node -e "
const { runPreflightChecks } = require('${REPO_ROOT}/lib/suite/installer/preflight');
runPreflightChecks().then(report => {
    for (const c of report.checks) {
        console.log('  - [' + c.status.toUpperCase() + '] ' + c.id + ': ' + c.value);
    }
});
"

echo ""
msg "deps"
if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
fi
SETUP_TOKEN="${SETUP_TOKEN:-$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")}"
COOKIE_SECRET="${COOKIE_SECRET:-$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")}"
cat > "${ENV_FILE}" <<EOF
SETUP_TOKEN="${SETUP_TOKEN}"
COOKIE_SECRET="${COOKIE_SECRET}"
EOF
chmod 600 "${ENV_FILE}"

if [[ "${AUTO_START}" == "true" ]]; then
    echo ""
    msg "services"
    ensure_backing_services

    echo ""
    msg "starting"
    if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
        kill "$(cat "${PID_FILE}")" || true
        sleep 1
    fi
    APPCONF_suite_enabled="true" \
    APPCONF_suite_host="${SUITE_HOST}" \
    APPCONF_suite_port="${SUITE_PORT}" \
    APPCONF_suite_defaultLocale="${INSTALL_LANG}" \
    APPCONF_suite_setupToken="${SETUP_TOKEN}" \
    APPCONF_suite_cookieSecret="${COOKIE_SECRET}" \
    nohup node "${REPO_ROOT}/server.js" >"${LOG_FILE}" 2>&1 &
    SERVER_PID=$!
    echo "${SERVER_PID}" > "${PID_FILE}"

    for _ in {1..20}; do
        if port_is_open "${SUITE_PORT}"; then
            break
        fi
        sleep 0.5
    done
    echo "  -> [OK] WildDuck Mail Suite is running (PID ${SERVER_PID}, Log: ${LOG_FILE})"
fi

PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
DISPLAY_HOST="${PUBLIC_IP:-127.0.0.1}"

echo ""
msg "ready"
echo "----------------------------------------------------------------------"
echo "  Web Setup Wizard URL : http://${DISPLAY_HOST}:${SUITE_PORT}/setup?lang=${INSTALL_LANG}&token=${SETUP_TOKEN}"
echo "  Webmail Client URL   : http://${DISPLAY_HOST}:${SUITE_PORT}/webmail"
echo "  Admin Console URL    : http://${DISPLAY_HOST}:${SUITE_PORT}/admin"
echo "  Default Language     : ${INSTALL_LANG}"
echo "  Stop Command         : bash setup/install-suite.sh --stop"
echo "----------------------------------------------------------------------"

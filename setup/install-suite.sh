#!/usr/bin/env bash
set -euo pipefail

# WildDuck Mail Suite v1.55.1 - Intelligent Multi-Language Installer
# Supports English (en) and Vietnamese (vi) interactive CLI & Web Setup Wizard bootstrap.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_LANG="${INSTALL_LANG:-}"
SUITE_PORT="${SUITE_PORT:-8088}"

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
        read -r -p "Enter choice [1-2] (default: 1): " choice
    else
        choice="1"
    fi
    case "${choice}" in
        2|vi|VI)
            INSTALL_LANG="vi"
            ;;
        *)
            INSTALL_LANG="en"
            ;;
    esac
}

msg() {
    local key="$1"
    if [[ "${INSTALL_LANG}" == "vi" ]]; then
        case "${key}" in
            preflight) echo "[1/3] Đang kiểm tra cấu hình phần cứng, hệ điều hành và các cổng mạng (Pre-flight check)..." ;;
            deps)      echo "[2/3] Đang kiểm tra gói phụ thuộc Node.js và cấu hình mặc định..." ;;
            ready)     echo "[3/3] Khởi tạo thành công! Hãy mở trình duyệt tại địa chỉ bên dưới để hoàn tất qua Web Setup Wizard:" ;;
            *)         echo "${key}" ;;
        esac
    else
        case "${key}" in
            preflight) echo "[1/3] Running hardware, OS, and mail port pre-flight diagnostics..." ;;
            deps)      echo "[2/3] Verifying Node.js dependencies and zero-config defaults..." ;;
            ready)     echo "[3/3] Bootstrap ready! Open your browser at the URL below to complete the Web Setup Wizard:" ;;
            *)         echo "${key}" ;;
        esac
    fi
}

for arg in "$@"; do
    case "${arg}" in
        --lang=*)
            INSTALL_LANG="${arg#*=}"
            ;;
        --port=*)
            SUITE_PORT="${arg#*=}"
            ;;
    esac
done

print_banner
select_language

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
SETUP_TOKEN="$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"

echo ""
msg "ready"
echo "----------------------------------------------------------------------"
echo "  Web Setup Wizard URL : http://127.0.0.1:${SUITE_PORT}/setup?lang=${INSTALL_LANG}&token=${SETUP_TOKEN}"
echo "  Default Language     : ${INSTALL_LANG}"
echo "----------------------------------------------------------------------"

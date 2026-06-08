#!/usr/bin/env bash
# Run idf.py with the correct SDKCONFIG_DEFAULTS for an ESP32-S3 board variant.
#
# Usage:
#   ./scripts/idf-s3.sh devkit-mini set-target esp32s3
#   ./scripts/idf-s3.sh freenove set-target esp32s3
#   ./scripts/idf-s3.sh devkit-mini build flash monitor
#   ./scripts/idf-s3.sh waveshare-zero build flash monitor
#
# Switching boards: remove sdkconfig first, then set-target again with the new board.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOARD="${1:?usage: $0 <devkit-mini|freenove|waveshare-zero> [idf.py args...]}"
shift

ensure_idf_env() {
  if command -v idf.py &>/dev/null; then
    return 0
  fi
  local export_sh=""
  if [[ -n "${IDF_PATH:-}" && -f "${IDF_PATH}/export.sh" ]]; then
    export_sh="${IDF_PATH}/export.sh"
  elif [[ -f "${HOME}/.espressif/v6.0/esp-idf/export.sh" ]]; then
    export_sh="${HOME}/.espressif/v6.0/esp-idf/export.sh"
  elif [[ -f "${HOME}/esp/esp-idf/export.sh" ]]; then
    export_sh="${HOME}/esp/esp-idf/export.sh"
  fi
  if [[ -z "$export_sh" ]]; then
    echo "ESP-IDF not found. Run: source \$IDF_PATH/export.sh" >&2
    echo "Or set IDF_PATH to your esp-idf checkout." >&2
    exit 127
  fi
  # shellcheck disable=SC1090
  source "$export_sh" >/dev/null
  if ! command -v idf.py &>/dev/null; then
    echo "Sourced ${export_sh} but idf.py is still not on PATH." >&2
    exit 127
  fi
}

case "$BOARD" in
  devkit-mini|mini|devkit)
    FRAG="sdkconfig.defaults.esp32s3.board-devkit-mini"
    ;;
  freenove|freenove-wroom-lite|fnk0102)
    FRAG="sdkconfig.defaults.esp32s3.board-freenove-wroom-lite"
    ;;
  waveshare-zero|zero|waveshare)
    FRAG="sdkconfig.defaults.esp32s3.board-waveshare-zero"
    ;;
  *)
    echo "Unknown board: $BOARD" >&2
    echo "Use: devkit-mini | freenove | waveshare-zero" >&2
    exit 1
    ;;
esac

ensure_idf_env

export SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;${FRAG}"
cd "$ROOT"
echo "SDKCONFIG_DEFAULTS=$SDKCONFIG_DEFAULTS" >&2
exec idf.py "$@"

#!/usr/bin/env bash
# ==============================================================================
# Universal Christ University k6 Load Test Runner (Linux / macOS / Cloud Server)
# ==============================================================================

set -e

HAR_ARG=""
VUS_ARG=0
DURATION_ARG=""
SCRIPT_ARG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--har)
      HAR_ARG="$2"
      shift 2
      ;;
    -u|-v|--vus)
      VUS_ARG="$2"
      shift 2
      ;;
    -d|--duration)
      DURATION_ARG="$2"
      shift 2
      ;;
    -s|--script)
      SCRIPT_ARG="$2"
      shift 2
      ;;
    -c|--csv)
      CSV_ARG="$2"
      shift 2
      ;;
    *)
      if [[ -z "$HAR_ARG" ]]; then
        HAR_ARG="$1"
      elif [[ $VUS_ARG -eq 0 ]]; then
        VUS_ARG="$1"
      fi
      shift
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================================"
echo "   ⚡ Christ University k6 Enterprise Load Testing Suite ⚡"
echo "============================================================"

# 1. Start background telemetry server if not running
if ! curl -s http://127.0.0.1:3001/api/status > /dev/null 2>&1; then
  echo "📡 Starting background Web Control Center on port 3001..."
  nohup node tests/christ_university/reports/report_server.js > /dev/null 2>&1 &
  sleep 1
fi

# 2. Resolve script & Auto-Convert if new HAR file
TARGET_SCRIPT=""
if [[ -n "$SCRIPT_ARG" ]]; then
  TARGET_SCRIPT="$SCRIPT_ARG"
elif [[ -n "$HAR_ARG" ]]; then
  if [[ "$HAR_ARG" == *"prepespro.christ"* || "$HAR_ARG" == "prepespro" ]]; then
    TARGET_SCRIPT="tests/prepespro_har_load_test.js"
  elif [[ "$HAR_ARG" == *"prepespro2"* ]]; then
    TARGET_SCRIPT="tests/prepespro2_har_load_test.js"
  else
    HAR_FILE=""
    if [[ -f "$HAR_ARG" ]]; then
      HAR_FILE="$HAR_ARG"
    elif [[ -f "har_files/$HAR_ARG" ]]; then
      HAR_FILE="har_files/$HAR_ARG"
    elif [[ -f "har_files/${HAR_ARG}.har" ]]; then
      HAR_FILE="har_files/${HAR_ARG}.har"
    fi

    if [[ -n "$HAR_FILE" ]]; then
      BASE_NAME=$(basename "$HAR_FILE" .har | tr -cd '[:alnum:]_-')
      TARGET_SCRIPT="tests/${BASE_NAME}_load_test.js"
      if [[ ! -f "$TARGET_SCRIPT" || "$HAR_FILE" -nt "$TARGET_SCRIPT" ]]; then
        echo "⚡ [Auto-Convert] Converting '$HAR_FILE' into k6 script: $TARGET_SCRIPT..."
        node tools/convert_har.js "$HAR_FILE" "$TARGET_SCRIPT"
      fi
    else
      TARGET_SCRIPT="tests/prepespro2_har_load_test.js"
    fi
  fi
else
  TARGET_SCRIPT="tests/prepespro2_har_load_test.js"
fi

# 3. Resolve VUs
VUS=${VUS_ARG:-50}
if [[ $VUS -le 0 ]]; then
  VUS=50
fi

# 4. Trigger release of port 5665
curl -s http://127.0.0.1:3001/api/release-5665 > /dev/null 2>&1 || true

echo "• Target Script : $TARGET_SCRIPT"
echo "• Virtual Users : $VUS VUs"
echo "• Grafana Port  : http://127.0.0.1:5665"
echo "• Control Center: http://127.0.0.1:3001"
echo "============================================================"

export K6_WEB_DASHBOARD=true
export K6_WEB_DASHBOARD_PORT=5665
export K6_WEB_DASHBOARD_EXPORT=tests/christ_university/reports/grafana_report.html
export VUS=$VUS
export DURATION="$DURATION_ARG"
export CREDENTIALS_FILE="${CSV_ARG:-./data/students.csv}"

if [[ -n "$DURATION_ARG" ]]; then
  k6 run -u "$VUS" -d "$DURATION_ARG" "$TARGET_SCRIPT"
else
  k6 run -u "$VUS" -i "$VUS" "$TARGET_SCRIPT"
fi

# 5. Reclaim port 5665 for persistent dashboard
curl -s http://127.0.0.1:3001/api/claim-5665 > /dev/null 2>&1 || true

echo ""
echo "✅ Load test completed successfully!"
echo "📊 Web Dashboard & Diagnostics: http://127.0.0.1:3001"

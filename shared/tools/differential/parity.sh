#!/usr/bin/env bash
#
# Generate, answer twice, compare. One command, so that a red build is one
# command to reproduce.
#
#   shared/tools/differential/parity.sh              # seed 1, 5000 cases
#   shared/tools/differential/parity.sh 7 20000      # a specific seed and size
#
# Expects the TypeScript edition to be built (`npm run build` in typescript/)
# and a Python interpreter with the Python edition importable. Everything is
# written to a scratch directory, so nothing in the repository changes.
set -euo pipefail

seed="${1:-1}"
cases="${2:-5000}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
work="${PARITY_WORK_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/economyworld-parity}"
python_bin="${PYTHON:-python}"

mkdir -p "${work}"

echo "seed ${seed}, ${cases} cases"

node "${here}/generate.mjs" --seed "${seed}" --cases "${cases}" --out "${work}/cases.json"

node "${here}/run-typescript.mjs" --cases "${work}/cases.json" \
  --out "${work}/results-typescript.json"

PYTHONPATH="${root}/python/src" "${python_bin}" "${here}/run_python.py" \
  --cases "${work}/cases.json" --out "${work}/results-python.json"

"${python_bin}" "${here}/compare.py" \
  --cases "${work}/cases.json" \
  --python "${work}/results-python.json" \
  --typescript "${work}/results-typescript.json"

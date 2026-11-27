#!/bin/bash
#SBATCH --job-name=rice2net_layout
#SBATCH --output=rice2net_layout_%j.out
#SBATCH --error=rice2net_layout_%j.err
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=16G
#SBATCH --time=00:30:00

# Rice2Net High-Performance Precomputed Layout Script (Local & HPC SLURM compatible)
#
# Local usage:
#   bash tools/run_layout_hpc.slurm /path/to/network_main_edges.tsv [min_z] [out_dir]
#
# SLURM usage:
#   sbatch tools/run_layout_hpc.slurm /path/to/network_main_edges.tsv 0.75 ./layout_out

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT_TSV="${1:-/home/m13paiva/Desktop/network_main_edges.tsv}"
MIN_Z="${2:-0.75}"
OUT_DIR="${3:-${SCRIPT_DIR}/../layout_out}"
TICKS="${TICKS:-400}"
WEIGHT_MODE="${WEIGHT_MODE:-d3}" # 'd3' (exact Rice2Net) or 'zscore'

THREADS="${SLURM_CPUS_PER_TASK:-$(nproc 2>/dev/null || echo 4)}"
export OMP_NUM_THREADS="${THREADS}"
export OMP_PROC_BIND=true

mkdir -p "${OUT_DIR}"

BIN="${SCRIPT_DIR}/compute_layout"
SRC="${SCRIPT_DIR}/compute_layout.cpp"

if [[ ! -x "${BIN}" || "${SRC}" -nt "${BIN}" ]]; then
  echo "[Build] Compiling ${SRC} with OpenMP..."
  g++ -O3 -march=native -fopenmp -std=c++17 "${SRC}" -o "${BIN}"
fi

TAG="z${MIN_Z//./}"
OUT_NODES="${OUT_DIR}/network_${TAG}_nodes.tsv"
OUT_EDGES="${OUT_DIR}/network_${TAG}_edges.tsv"
OUT_JSON="${OUT_DIR}/network_${TAG}_layout.json"

echo "[Run] Input:   ${INPUT_TSV}"
echo "[Run] Min Z:   ${MIN_Z}"
echo "[Run] Threads: ${THREADS}"
echo "[Run] Ticks:   ${TICKS}"
echo "[Run] Output:  ${OUT_DIR}"

"${BIN}" \
  --input "${INPUT_TSV}" \
  --min-z "${MIN_Z}" \
  --ticks "${TICKS}" \
  --weight-mode "${WEIGHT_MODE}" \
  --threads "${THREADS}" \
  --out-nodes "${OUT_NODES}" \
  --out-edges "${OUT_EDGES}" \
  --out-json "${OUT_JSON}"

ls -lh "${OUT_NODES}" "${OUT_EDGES}" "${OUT_JSON}"

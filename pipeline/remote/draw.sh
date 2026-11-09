#!/usr/bin/env bash
# Runs ON the rented GPU (image ostris/aitoolkit, ai-toolkit at /app/ai-toolkit).
# Draws render blocks with the trained LoRA. Progress goes to R2 runs/$RUN/box.json; any exit before
# "done" reports "failed" so the GitHub side deletes the machine at once.
# Env: RUN, ATTEMPT, LORA_KEY, ANGLES, BLOCKS, LIMIT, DRAW_RUN, STRIDE, R2_*
set -uo pipefail
cd /root
exec > >(tee -a /root/run.log) 2>&1
echo "start $(date -u +%FT%TZ) attempt ${ATTEMPT}"
pip install -q --break-system-packages boto3 >/dev/null 2>&1 || pip install -q boto3 >/dev/null 2>&1
status() {
  python3 - "$1" "${2:-}" <<'PY'
import boto3, json, os, sys, time
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
body = json.dumps({"state": sys.argv[1], "detail": sys.argv[2], "attempt": os.environ["ATTEMPT"], "t": time.time()}).encode()
for i in range(8):
    try:
        s3.put_object(Bucket="iso-burlington", Key=f"runs/{os.environ['RUN']}/box.json", Body=body, ContentType="application/json"); sys.exit(0)
    except Exception as e:
        print("status put failed:", e); time.sleep(5 * (i + 1))
sys.exit(1)
PY
}
upload_log() { python3 -c "
import boto3, os
s3 = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto')
s3.upload_file('/root/run.log', 'iso-burlington', f\"runs/{os.environ['RUN']}/run.log\")" || true; }
trap 'rc=$?; status failed "draw.sh stopped early (rc=$rc), see run.log"; upload_log' EXIT
status booted
nvidia-smi --query-gpu=name,driver_version,power.limit,power.default_limit --format=csv,noheader || true
read -r PL PD <<<"$(nvidia-smi --query-gpu=power.limit,power.default_limit --format=csv,noheader,nounits | head -1 | tr -d ' ' | tr ',' ' ')"
if python3 -c "import sys
try: sys.exit(0 if float('$PL') >= 0.65*float('$PD') else 1)
except ValueError: sys.exit(0)"; then :; else
  trap - EXIT; status refused "GPU power capped at ${PL} W (default ${PD} W)"; upload_log; exit 3; fi
export HF_HUB_ENABLE_HF_TRANSFER=1 AITK=/app/ai-toolkit
python3 -c "
import boto3, os
s3 = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto')
s3.download_file('iso-burlington', os.environ['LORA_KEY'], '/root/lora.safetensors')" || exit 4
( while true; do sleep 300; upload_log >/dev/null 2>&1; done ) &
cd /app/ai-toolkit
ARGS=(--angles "$ANGLES" --lora /root/lora.safetensors --limit "${LIMIT:-0}")
[ -n "${BLOCKS:-}" ] && ARGS+=("--blocks=$BLOCKS")   # = form: block ids can start with "-"
python3 /root/iso/pipeline/remote/draw.py "${ARGS[@]}"
RC=$?
trap - EXIT
if [ $RC -eq 0 ]; then status done; else status failed "draw.py rc=$RC, see run.log"; fi
upload_log
echo "end $(date -u +%FT%TZ) rc=$RC"
sleep infinity

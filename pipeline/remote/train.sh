#!/usr/bin/env bash
# Runs ON the rented GPU (image ostris/aitoolkit, ai-toolkit at /app/ai-toolkit).
# Trains the style LoRA and streams everything to R2. Any exit before "done" reports "failed",
# so the GitHub side deletes the machine at once instead of waiting for the deadline.
# Env: RUN, ATTEMPT, PAIRS, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
set -uo pipefail
cd /root
exec > >(tee -a /root/run.log) 2>&1
echo "start $(date -u +%FT%TZ) attempt ${ATTEMPT}"
AITK=/app/ai-toolkit
pip install -q --break-system-packages boto3 >/dev/null 2>&1 || pip install -q boto3 >/dev/null 2>&1

status() {  # status <state> [detail] -- retried; returns non-zero only if every try failed
  python3 - "$1" "${2:-}" <<'PY'
import boto3, json, os, sys, time
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
body = json.dumps({"state": sys.argv[1], "detail": sys.argv[2], "attempt": os.environ["ATTEMPT"], "t": time.time()}).encode()
for i in range(8):
    try:
        s3.put_object(Bucket="iso-burlington", Key=f"runs/{os.environ['RUN']}/box.json", Body=body, ContentType="application/json")
        sys.exit(0)
    except Exception as e:
        print("status put failed:", e); time.sleep(5 * (i + 1))
sys.exit(1)
PY
}
trap 'rc=$?; status failed "train.sh stopped early (rc=$rc), see run.log"; python3 /root/sync.py || true' EXIT

status booted
nvidia-smi --query-gpu=name,driver_version,power.limit,power.default_limit --format=csv,noheader || true

# 1. refuse a slow or power-capped GPU ([N/A] readings are allowed through)
read -r PL PD <<<"$(nvidia-smi --query-gpu=power.limit,power.default_limit --format=csv,noheader,nounits | head -1 | tr -d ' ' | tr ',' ' ')"
echo "gpu power limit ${PL} W of default ${PD} W"
if python3 -c "import sys
try: sys.exit(0 if float('$PL') >= 0.9*float('$PD') else 1)
except ValueError: sys.exit(0)"; then :; else
  trap - EXIT; status refused "GPU power capped at ${PL} W (default ${PD} W)"; exit 3; fi

cd "$AITK" && echo "ai-toolkit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
python3 -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda, torch.cuda.get_device_name(0))"
export HF_HUB_ENABLE_HF_TRANSFER=1

# 2. training data from R2
status "downloading data"
python3 - <<'PY'
import boto3, json, os
from pathlib import Path
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
tgt, ctl, val = Path("/root/data/target"), Path("/root/data/control"), Path("/root/data/val")
for p in (tgt, ctl, val): p.mkdir(parents=True, exist_ok=True)
caption = open("/root/caption.txt").read().strip()
n = 0
for prefix in os.environ["PAIRS"].split(","):
    man = json.loads(s3.get_object(Bucket="iso-burlington", Key=f"{prefix}/manifest.json")["Body"].read())
    a = man["angle"]
    for it in man["items"]:
        if not it.get("ok"): continue
        i = f"a{a}_{it['id']}"
        if it["split"] == "val":
            s3.download_file("iso-burlington", f"{prefix}/pairs/{it['id']}.render.png", str(val / f"{i}.png"))
            s3.download_file("iso-burlington", f"{prefix}/pairs/{it['id']}.target.png", str(val / f"{i}.target.png"))
            continue
        s3.download_file("iso-burlington", f"{prefix}/pairs/{it['id']}.target.png", str(tgt / f"{i}.png"))
        s3.download_file("iso-burlington", f"{prefix}/pairs/{it['id']}.render.png", str(ctl / f"{i}.png"))
        (tgt / f"{i}.txt").write_text(caption)
        n += 1
print("train pairs", n, "val", len(list(val.glob("*.target.png"))))
assert n >= 50, "too few training pairs"
PY
[ $? -eq 0 ] || exit 4

# 3. stream outputs to R2 every 2 minutes while training
( while true; do sleep 120; python3 /root/sync.py >/dev/null 2>&1 || true; done ) &
SYNC=$!

# 4. train
status training
cd "$AITK"
python3 run.py /root/train.yaml
RC=$?
kill $SYNC 2>/dev/null
SYNC_OK=1
for i in 1 2 3; do python3 /root/sync.py && { SYNC_OK=0; break; }; sleep 10; done
trap - EXIT
if [ $RC -eq 0 ] && [ $SYNC_OK -eq 0 ]; then status done; else status failed "ai-toolkit rc=$RC, final sync ok=$((1-SYNC_OK))"; fi
echo "end $(date -u +%FT%TZ) rc=$RC"
sleep infinity   # the GitHub job deletes this machine once it sees done/failed

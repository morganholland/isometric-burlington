#!/usr/bin/env bash
# Runs ON the rented GPU. Trains the style LoRA with ai-toolkit and streams everything to R2.
# Env: RUN (name), PAIRS (comma list of R2 prefixes holding *.render.png/*.target.png),
#      STEPS, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, AITK_COMMIT, ISO_COMMIT
set -uo pipefail
cd /root
exec > >(tee -a /root/run.log) 2>&1
echo "start $(date -u +%FT%TZ)"
pip install -q boto3 >/dev/null 2>&1

python3 - <<'PY'
import boto3, json, os, time
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
s3.put_object(Bucket="iso-burlington", Key=f"runs/{os.environ['RUN']}/box.json",
              Body=json.dumps({"state": "booted", "t": time.time()}).encode(), ContentType="application/json")
PY

status() {  # status <state> [detail]
  python3 - "$1" "${2:-}" <<'PY'
import boto3, json, os, sys, time
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
s3.put_object(Bucket="iso-burlington", Key=f"runs/{os.environ['RUN']}/box.json",
              Body=json.dumps({"state": sys.argv[1], "detail": sys.argv[2], "t": time.time()}).encode(), ContentType="application/json")
PY
}

# 1. refuse a slow or power-capped GPU
read -r PL PD <<<"$(nvidia-smi --query-gpu=power.limit,power.default_limit --format=csv,noheader,nounits | head -1 | tr -d ' ' | tr ',' ' ')"
echo "gpu power limit ${PL} W of default ${PD} W"
if python3 -c "import sys; sys.exit(0 if float('$PL') >= 0.9*float('$PD') else 1)"; then :; else
  status "refused" "GPU power capped at ${PL} W (default ${PD} W)"; exit 3; fi

# 2. ai-toolkit at a pinned commit
status "installing"
git clone -q https://github.com/ostris/ai-toolkit /root/ai-toolkit && cd /root/ai-toolkit && git checkout -q "$AITK_COMMIT" && git submodule update -q --init --recursive
pip install -q -r requirements.txt 2>&1 | tail -3
export HF_HUB_ENABLE_HF_TRANSFER=1

# 3. training data from R2
status "downloading data"
python3 - <<'PY'
import boto3, os
from pathlib import Path
s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
tgt, ctl, val = Path("/root/data/target"), Path("/root/data/control"), Path("/root/data/val")
for p in (tgt, ctl, val): p.mkdir(parents=True, exist_ok=True)
caption = open("/root/caption.txt").read().strip()
n = 0
for prefix in os.environ["PAIRS"].split(","):
    man = __import__("json").loads(s3.get_object(Bucket="iso-burlington", Key=f"{prefix}/manifest.json")["Body"].read())
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
PY

# 4. stream outputs to R2 every 2 minutes while training
(
  while true; do
    sleep 120
    python3 /root/sync.py >/dev/null 2>&1 || true
  done
) &
SYNC=$!

# 5. train
status "training"
cd /root/ai-toolkit
python3 run.py /root/train.yaml
RC=$?
kill $SYNC 2>/dev/null
python3 /root/sync.py || true
if [ $RC -eq 0 ]; then status "done"; else status "failed" "ai-toolkit exited $RC"; fi
echo "end $(date -u +%FT%TZ) rc=$RC"
python3 /root/sync.py || true
sleep infinity   # the GitHub job deletes this machine once it sees done/failed

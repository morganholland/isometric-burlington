"""Copy new/changed training outputs (checkpoints, samples, log) from the GPU box to R2."""
import os, json, sys
from pathlib import Path
import boto3

s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
run = os.environ["RUN"]
state_f = Path("/root/.synced.json")
seen = json.loads(state_f.read_text()) if state_f.exists() else {}
root = Path(os.environ.get("AITK_OUTPUT", "/root/output"))
failed = 0
if root.exists():
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix not in (".safetensors", ".jpg", ".png", ".yaml", ".txt", ".json", ".log"):
            continue
        st = p.stat()
        key = f"runs/{run}/out/{p.relative_to(root).as_posix()}"
        sig = f"{st.st_size}:{int(st.st_mtime)}"
        if seen.get(key) == sig:
            continue
        try:
            s3.upload_file(str(p), "iso-burlington", key)
            seen[key] = sig
        except Exception as e:  # noqa: BLE001
            print("upload failed", key, e); failed += 1
try:
    s3.upload_file("/root/run.log", "iso-burlington", f"runs/{run}/run.log")
except Exception as e:  # noqa: BLE001
    print("log upload failed", e); failed += 1
state_f.write_text(json.dumps(seen))
sys.exit(1 if failed else 0)

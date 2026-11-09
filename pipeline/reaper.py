"""Delete any Vast.ai machine of ours that is past the deadline written in its label (iso-<name>-dl<epoch>).
Runs every 30 minutes from GitHub, so a crashed job can never leave a GPU billing."""
import re, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import vast

now = time.time()
for i in vast.mine():
    label = i.get("label") or ""
    m = re.match(r"iso-.*-dl(\d+)$", label)
    if not m:
        continue
    if now > int(m.group(1)) + 600:
        ok = vast.destroy(i["id"])
        print(f"deleted {i['id']} ({label}) past its deadline: {ok}")
    else:
        print(f"keeping {i['id']} ({label}), {int((int(m.group(1)) - now) / 60)} min left")

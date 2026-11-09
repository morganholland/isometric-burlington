"""Delete any Vast.ai machine of ours past the deadline in its label (iso-<name>-dl<epoch>), and any
iso-* machine older than 6 hours whatever its label says. Runs every 30 minutes from GitHub."""
import re, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import vast

now = time.time()
ours = 0
for i in vast.mine():
    label = i.get("label") or ""
    if not label.startswith("iso-"):
        continue
    ours += 1
    m = re.match(r"iso-.*-dl(\d+)$", label)
    age_h = (now - float(i.get("start_date") or now)) / 3600
    if (m and now > int(m.group(1)) + 600) or age_h > 6:
        print(f"deleting {i['id']} ({label}), age {age_h:.1f} h: {vast.destroy(i['id'])}")
    else:
        print(f"keeping {i['id']} ({label}), age {age_h:.1f} h")
print(f"{ours} iso machines seen")

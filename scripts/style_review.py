"""Build the style-review page from a finished teacher_test run (downloaded from R2).

python3 scripts/style_review.py <run_dir> <out.html>
"""
import base64, io, json, sys
from pathlib import Path
from PIL import Image

run = Path(sys.argv[1]); out = Path(sys.argv[2])
data = json.loads((run / "results.json").read_text())
LOOKS = {"builder": "City-builder", "gouache": "Storybook gouache"}
MODELS = {"gpt-image-2.6-flare": "2.6 flare", "gpt-image-2.6-sunburst": "2.6 sunburst"}


def uri(path, size=800):
    im = Image.open(path).convert("RGB")
    im.thumbnail((size, size), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, "WEBP", quality=72)
    return "data:image/webp;base64," + base64.b64encode(b.getvalue()).decode()


by = {}
for r in data["results"]:
    by[(r["spot"], r["model"], r["look"])] = r
models = sorted({r["model"] for r in data["results"]})
looks = [l for l in LOOKS if any(r["look"] == l for r in data["results"])]

# pass rate per (model, look)
rate = {}
for m in models:
    for l in looks:
        rs = [r for r in data["results"] if r["model"] == m and r["look"] == l]
        ok = sum(1 for r in rs if r.get("check", {}).get("pass"))
        rate[(m, l)] = (ok, len(rs))

spots_html = []
for s in data["spots"]:
    if "frame" not in s or s.get("error"):
        continue
    name = f"{s['frame'][0]}_{s['frame'][1]}"
    render = run / "renders" / f"{name}.png"
    if not render.exists():
        continue
    cells = [f'<figure class="cell render"><img loading="lazy" alt="Google 3D render of {s["label"]}" src="{uri(render)}"><figcaption>Render (input)</figcaption></figure>']
    for l in looks:
        for m in models:
            r = by.get((s["id"], m, l))
            if not r or "file" not in r:
                cells.append(f'<figure class="cell missing" data-look="{l}"><div class="gap">No drawing</div><figcaption>{LOOKS[l]} · {MODELS.get(m, m)}</figcaption></figure>')
                continue
            c = r["check"]
            badge = '<span class="ok">passes checks</span>' if c["pass"] else f'<span class="bad">{", ".join(c["reasons"])}</span>'
            cells.append(f'<figure class="cell" data-look="{l}"><img loading="lazy" alt="{LOOKS[l]} drawing of {s["label"]}" src="{uri(run / "drawn" / r["file"])}">'
                         f'<figcaption>{LOOKS[l]} · {MODELS.get(m, m)} {badge}</figcaption></figure>')
    spots_html.append(f'<section class="spot"><h2>{s["label"]}</h2><div class="grid">{"".join(cells)}</div></section>')

summary = "".join(
    f'<li><b>{LOOKS[l]}</b> · {MODELS.get(m, m)}: {rate[(m, l)][0]} of {rate[(m, l)][1]} pass the checks</li>'
    for l in looks for m in models)

html = (Path(__file__).parent / "style_review_template.html").read_text()
html = html.replace("{{SUMMARY}}", summary).replace("{{SPOTS}}", "\n".join(spots_html)).replace("{{N}}", str(len(spots_html)))
out.write_text(html)
print(f"wrote {out} ({out.stat().st_size/1e6:.1f} MB, {len(spots_html)} spots)")

"""Cut finished blocks into a zoomable WebP tile pyramid and (optionally) upload to R2.

Blocks are BLOCKxBLOCK PNGs named {bx}_{by}.png in absolute map pixels (see geo.py).
Tiles are 512 px, indexed in absolute map pixels so the viewer needs no offsets:
  level 0  : tile (tx, ty) covers map px [tx*512, (tx+1)*512) x [ty*512, ...)
  level -k : tile covers 512*2^k map px, downsampled 2^k times.
Output: {out}/{kind}/a{angle}/{z}/{x}/{y}.webp

python3 pipeline/tiles.py --angle 0 --blocks drawn/a0 --out tiles --kind drawn --min-zoom -7
python3 pipeline/tiles.py --upload tiles      # needs R2_* env vars
"""
import argparse, json, math, os, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image

T = 512
Image.MAX_IMAGE_PIXELS = None


def cut_block(im, bx, by, out_dir, quality):
    """Cut one RGBA block at map pixel (bx, by) into level-0 tiles; returns the tiles written."""
    tiles = set()
    for j in range(im.height // T):
        for i in range(im.width // T):
            t = im.crop((i * T, j * T, (i + 1) * T, (j + 1) * T))
            if t.getextrema()[3][1] == 0:   # fully transparent
                continue
            tx, ty = bx // T + i, by // T + j
            p = out_dir / "0" / str(tx) / f"{ty}.webp"
            p.parent.mkdir(parents=True, exist_ok=True)
            save(t, p, quality)
            tiles.add((tx, ty))
    return tiles


def cut_level0(blocks_dir, out_dir, quality):
    tiles = set()
    for f in sorted(Path(blocks_dir).glob("*.png")):
        if f.name.endswith(".h.png"):
            continue
        bx, by = map(int, f.stem.split("_"))
        tiles |= cut_block(Image.open(f).convert("RGBA"), bx, by, out_dir, quality)
    return tiles


def with_render_alpha(drawn, render):
    """The drawn block, clear wherever the render was clear (outside the map's region)."""
    d = drawn.convert("RGB").resize(render.size, Image.LANCZOS) if drawn.size != render.size else drawn.convert("RGB")
    out = d.convert("RGBA")
    out.putalpha(render.getchannel("A") if render.mode == "RGBA" else Image.new("L", render.size, 255))
    return out


def save(im, path, quality):
    alpha = im.getchannel("A")
    if alpha.getextrema()[0] == 255:
        im.convert("RGB").save(path, "WEBP", quality=quality, method=5)
    else:
        im.save(path, "WEBP", quality=quality, method=5)


def build_parent(z_dir_child, z_dir, tx, ty, quality):
    canvas = Image.new("RGBA", (T * 2, T * 2), (0, 0, 0, 0))
    any_ = False
    for dy in (0, 1):
        for dx in (0, 1):
            p = z_dir_child / str(tx * 2 + dx) / f"{ty * 2 + dy}.webp"
            if p.exists():
                canvas.paste(Image.open(p).convert("RGBA"), (dx * T, dy * T))
                any_ = True
    if not any_:
        return False
    out = z_dir / str(tx) / f"{ty}.webp"
    out.parent.mkdir(parents=True, exist_ok=True)
    save(canvas.resize((T, T), Image.LANCZOS), out, quality)
    return True


def pyramid(angle_dir, tiles0, min_zoom, quality):
    tiles = tiles0
    for z in range(-1, min_zoom - 1, -1):
        parents = {(math.floor(x / 2), math.floor(y / 2)) for x, y in tiles}
        child, cur = angle_dir / str(z + 1), angle_dir / str(z)
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(lambda xy: build_parent(child, cur, xy[0], xy[1], quality), parents))
        tiles = parents
        print(f"  z={z}: {len(parents)} tiles")
    return tiles


def upload(root):
    import boto3
    s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"],
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
    bucket = os.environ.get("R2_BUCKET", "iso-burlington")
    files = [p for p in Path(root).rglob("*") if p.is_file()]

    def put(p):
        key = p.relative_to(root).as_posix()
        ct = "image/webp" if p.suffix == ".webp" else "application/json"
        cc = "public, max-age=31536000, immutable" if p.suffix == ".webp" else "no-cache"
        s3.upload_file(str(p), bucket, key, ExtraArgs={"ContentType": ct, "CacheControl": cc})
    with ThreadPoolExecutor(32) as ex:
        for i, _ in enumerate(ex.map(put, files)):
            if i % 2000 == 0:
                print(f"  uploaded {i}/{len(files)}")
    print(f"uploaded {len(files)} files to {bucket}")


def set_cors():
    import boto3
    s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"],
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
    s3.put_bucket_cors(Bucket=os.environ.get("R2_BUCKET", "iso-burlington"), CORSConfiguration={"CORSRules": [
        {"AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400}]})


def write_manifest(root, kinds, min_zoom):
    m = {"minZoom": min_zoom, "maxZoom": 0, "angles": kinds}
    (Path(root) / "manifest.json").write_text(json.dumps(m))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--angle", type=int)
    ap.add_argument("--blocks")
    ap.add_argument("--out", default="tiles")
    ap.add_argument("--kind", default="drawn")
    ap.add_argument("--min-zoom", type=int, default=-7)
    ap.add_argument("--quality", type=int, default=84)
    ap.add_argument("--upload")
    ap.add_argument("--cors", action="store_true")
    ap.add_argument("--manifest", help='JSON list, e.g. ["drawn",null,null,null]')
    a = ap.parse_args()
    if a.cors:
        set_cors(); print("CORS set")
    if a.blocks:
        adir = Path(a.out) / a.kind / f"a{a.angle}"
        t0 = cut_level0(a.blocks, adir, a.quality)
        print(f"angle {a.angle}: {len(t0)} native tiles")
        pyramid(adir, t0, a.min_zoom, a.quality)
    if a.manifest:
        write_manifest(a.out, json.loads(a.manifest), a.min_zoom)
    if a.upload:
        upload(a.upload)

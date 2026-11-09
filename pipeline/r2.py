"""Small R2 helper (S3 API). Needs R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."""
import json, mimetypes, os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BUCKET = os.environ.get("R2_BUCKET", "iso-burlington")
_client = None


def client():
    global _client
    if _client is None:
        import boto3
        _client = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"],
                               aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                               aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
    return _client


def put_bytes(key, data, content_type="application/octet-stream", cache="no-cache"):
    client().put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type, CacheControl=cache)


def put_json(key, obj):
    put_bytes(key, json.dumps(obj, indent=1).encode(), "application/json")


def put_dir(local, prefix, cache="no-cache"):
    files = [p for p in Path(local).rglob("*") if p.is_file()]

    def one(p):
        ct = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if p.suffix == ".webp":
            ct = "image/webp"
        client().upload_file(str(p), BUCKET, f"{prefix}/{p.relative_to(local).as_posix()}",
                             ExtraArgs={"ContentType": ct, "CacheControl": cache})
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(one, files))
    return len(files)


def get_bytes(key):
    return client().get_object(Bucket=BUCKET, Key=key)["Body"].read()

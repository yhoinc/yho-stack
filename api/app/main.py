import os
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

# -----------------------------------------------------------------------------
# App setup
# -----------------------------------------------------------------------------
app = FastAPI(title="YHO Stack API")

# CORS so frontend can reach backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # you can restrict to ["https://yho-stack-1.onrender.com"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------------------
# Environment variables
# -----------------------------------------------------------------------------
S3_ENDPOINT = (os.environ.get("S3_ENDPOINT") or "").rstrip("/")
S3_BUCKET = os.environ.get("S3_BUCKET") or os.environ.get("R2_BUCKET") or ""
S3_ACCESS_KEY = (
    os.environ.get("S3_ACCESS_KEY_ID")
    or os.environ.get("R2_ACCESS_KEY_ID")
    or os.environ.get("AWS_ACCESS_KEY_ID")
    or ""
)
S3_SECRET_KEY = (
    os.environ.get("S3_SECRET_ACCESS_KEY")
    or os.environ.get("R2_SECRET_ACCESS_KEY")
    or os.environ.get("AWS_SECRET_ACCESS_KEY")
    or ""
)


# -----------------------------------------------------------------------------
# R2 client + helpers
# -----------------------------------------------------------------------------
def _r2_client():
    if not (S3_ENDPOINT and S3_BUCKET and S3_ACCESS_KEY and S3_SECRET_KEY):
        raise RuntimeError(
            "Missing S3/R2 env vars: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"
        )

    cfg = Config(
        region_name="auto",
        signature_version="s3v4",
        s3={"addressing_style": "path"},
        retries={"max_attempts": 3, "mode": "standard"},
    )

    endpoint_url = S3_ENDPOINT
    print(f"[r2] init endpoint_url={endpoint_url} bucket={S3_BUCKET}")

    return boto3.client(
        "s3",
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        endpoint_url=endpoint_url,
        config=cfg,
        verify=True,
    )


def _obj_to_row(obj: Dict[str, Any]) -> Dict[str, Any]:
    key = obj.get("Key", "")
    size = int(obj.get("Size") or 0)
    last_modified = obj.get("LastModified").isoformat() if obj.get("LastModified") else None
    base = key.rsplit("/", 1)[-1]
    lower = base.lower()
    doc_type: Optional[str] = None
    if "tax" in lower:
        doc_type = "tax"
    elif "id" in lower or "identification" in lower:
        doc_type = "identification"
    elif "deposit" in lower:
        doc_type = "direct_deposit"

    return {
        "key": key,
        "file": base,
        "size": size,
        "last_modified": last_modified,
        "doc_type": doc_type,
    }


# -----------------------------------------------------------------------------
# Document endpoints
# -----------------------------------------------------------------------------
@app.get("/documents")
def list_documents(
    limit: int = Query(50, ge=1, le=1000),
    prefix: str = Query("", description="Optional prefix to filter keys"),
):
    try:
        s3 = _r2_client()
        resp = s3.list_objects_v2(Bucket=S3_BUCKET, Prefix=prefix or "", MaxKeys=limit)
        contents = resp.get("Contents") or []
        rows = [_obj_to_row(o) for o in contents]
        return {"rows": rows, "limit": limit, "prefix": prefix}
    except (ClientError, BotoCoreError) as e:
        detail = f"R2 list error: {e}"
        print(f"[r2] list_documents error: {detail}")
        raise HTTPException(status_code=500, detail=detail)


@app.post("/documents/sync")
def sync_documents():
    try:
        s3 = _r2_client()
        resp = s3.list_objects_v2(Bucket=S3_BUCKET, MaxKeys=1)
        count = int(resp.get("KeyCount") or 0)
        return {"ok": True, "sample_count": count}
    except (ClientError, BotoCoreError) as e:
        detail = f"R2 sync failed: {e}"
        print(f"[r2] sync error: {detail}")
        raise HTTPException(status_code=500, detail=detail)


@app.post("/documents/upload")
async def upload_document(
    employee: str = Form(""),
    doc_type: str = Form(""),
    file: UploadFile = File(...),
):
    try:
        s3 = _r2_client()
        safe_emp = (employee or "unknown").strip().replace(" ", "_")
        safe_type = (doc_type or "misc").strip().replace(" ", "_")
        key = f"{safe_emp}/{safe_type}/{file.filename}"

        body = await file.read()
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType=file.content_type or "application/octet-stream",
        )
        return {"ok": True, "key": key, "size": len(body)}
    except (ClientError, BotoCoreError) as e:
        detail = f"R2 upload failed: {e}"
        print(f"[r2] upload error: {detail}")
        raise HTTPException(status_code=500, detail=detail)


# -----------------------------------------------------------------------------
# Healthcheck & placeholders for other routes
# -----------------------------------------------------------------------------
@app.get("/debug/health")
def healthcheck():
    return {"ok": True, "db": True}


@app.get("/employees")
def get_employees(limit: int = 100):
    # placeholder — your actual DB code goes here
    return {"rows": [], "limit": limit}


@app.get("/payroll/summary/payout_by_employee")
def payroll_summary():
    # placeholder — your actual DB code goes here
    return {"rows": []}

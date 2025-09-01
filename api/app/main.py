from __future__ import annotations

import os
import re
import time
from typing import List, Optional

import boto3
from botocore.config import Config
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ----- Config from env -----
S3_ENDPOINT = os.getenv("S3_ENDPOINT", "").strip().rstrip("/")
S3_REGION = os.getenv("S3_REGION", "us-east-1").strip()
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID", "")
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY", "")
S3_BUCKET = os.getenv("S3_BUCKET", "employee-docs")
FRONTEND_ORIGINS = [o.strip() for o in os.getenv("FRONTEND_ORIGINS", "").split(",") if o.strip()]

if not (S3_ENDPOINT and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
    # We'll still start so health works, but endpoints will 500 with a clear message
    pass

# boto3 client configured for Supabase S3-compat endpoint
_s3 = boto3.client(
    "s3",
    region_name=S3_REGION or "us-east-1",
    endpoint_url=S3_ENDPOINT if S3_ENDPOINT.startswith("http") else f"https://{S3_ENDPOINT}",
    aws_access_key_id=S3_ACCESS_KEY_ID,
    aws_secret_access_key=S3_SECRET_ACCESS_KEY,
    config=Config(
        s3={"addressing_style": "path"},   # Supabase expects path-style
        retries={"max_attempts": 3, "mode": "standard"},
        signature_version="s3v4",
    ),
)

app = FastAPI(title="YHO Stack API (Supabase Storage)")

# ----- CORS -----
_app_origins = FRONTEND_ORIGINS or [
    "https://yho-stack.onrender.com",
    "https://yho-stack-1.onrender.com",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_app_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
    max_age=600,
)

# ----- Helpers -----
_slug_re = re.compile(r"[^a-z0-9]+")
def slugify(s: str) -> str:
    s = s.lower().strip()
    s = _slug_re.sub("-", s)
    return s.strip("-") or "file"

def _require_storage_ready():
    if not (S3_ENDPOINT and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        raise HTTPException(status_code=500, detail="Storage credentials not configured")

def _ext(filename: str) -> str:
    p = filename.rfind(".")
    return filename[p + 1 :].lower() if p != -1 else "bin"

# ----- Schemas -----
class DocRow(BaseModel):
    key: str
    size: int
    last_modified: Optional[str] = None
    url: Optional[str] = None

class ListResponse(BaseModel):
    rows: List[DocRow]
    total: int

# ----- Health -----
@app.get("/debug/health")
def health():
    return {"ok": True, "storage": bool(S3_ENDPOINT)}

# ----- List from bucket -----
@app.get("/documents", response_model=ListResponse)
def list_documents(prefix: str = "", limit: int = 500):
    _require_storage_ready()
    try:
        # Paginate up to 'limit'
        rows: List[DocRow] = []
        kwargs = {"Bucket": S3_BUCKET, "Prefix": prefix, "MaxKeys": min(limit, 1000)}
        resp = _s3.list_objects_v2(**kwargs)
        while True:
            contents = resp.get("Contents", [])
            for obj in contents:
                rows.append(
                    DocRow(
                        key=obj["Key"],
                        size=int(obj.get("Size", 0)),
                        last_modified=(obj.get("LastModified") or "").isoformat() if obj.get("LastModified") else None,
                    )
                )
                if len(rows) >= limit:
                    break
            if len(rows) >= limit or not resp.get("IsTruncated"):
                break
            resp = _s3.list_objects_v2(Bucket=S3_BUCKET, Prefix=prefix, ContinuationToken=resp["NextContinuationToken"], MaxKeys=min(limit - len(rows), 1000))  # type: ignore
        return ListResponse(rows=rows, total=len(rows))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"S3 list error: {e}")

# ----- Upload -----
@app.post("/documents/upload", response_model=DocRow)
async def upload_document(
    employee_name: str = Form(""),
    doc_types: Optional[List[str]] = Form(default=None),
    file: UploadFile = File(...),
):
    _require_storage_ready()
    try:
        name_part = slugify(employee_name or "employee")
        types_part = "-".join([slugify(t) for t in (doc_types or [])]) or "doc"
        ts = int(time.time())
        ext = _ext(file.filename or "bin")
        key = f"{name_part}_{types_part}_{ts}.{ext}"

        data = await file.read()
        _s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=data,
            ContentType=file.content_type or "application/octet-stream",
        )
        # Make a short-lived signed URL for immediate viewing if needed
        url = _s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=3600,
        )
        return DocRow(key=key, size=len(data), url=url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"S3 upload error: {e}")

# ----- Signed download URL -----
@app.get("/documents/signed-url", response_model=DocRow)
def signed_url(key: str):
    _require_storage_ready()
    try:
        head = _s3.head_object(Bucket=S3_BUCKET, Key=key)
        url = _s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=3600,
        )
        return DocRow(
            key=key,
            size=int(head.get("ContentLength", 0)),
            url=url,
            last_modified=(head.get("LastModified") or "").isoformat() if head.get("LastModified") else None,
        )
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Not found or cannot sign: {e}")

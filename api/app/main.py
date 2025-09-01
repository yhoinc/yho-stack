import os
import sqlite3
import datetime
import traceback
from typing import Any, Dict, List, Optional

import boto3
import botocore
import certifi
from fastapi import FastAPI, Body, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# -------------------------------------------------------------------
# Config
# -------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", "employees_with_company_v2.db")
if not os.path.isabs(DB_PATH):
    DB_PATH = os.path.join(BASE_DIR, DB_PATH)

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "").strip()
S3_BUCKET = os.environ.get("S3_BUCKET", "").strip()
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "").strip()

# Helpful log line in Render logs
print(f"[startup] DB_PATH={DB_PATH}")
print(f"[startup] S3_ENDPOINT={repr(S3_ENDPOINT)}  S3_BUCKET={repr(S3_BUCKET)}")

# -------------------------------------------------------------------
# App
# -------------------------------------------------------------------
app = FastAPI(title="YHO API")

# Allow both the app and preview domains; also allow any origin (you can tighten later)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*",
                   "https://yho-stack.onrender.com",
                   "https://yho-stack-1.onrender.com"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=600,
)

# -------------------------------------------------------------------
# DB helpers
# -------------------------------------------------------------------
def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

# Minimal schema additions for documents (safe to run repeatedly)
DOCS_SCHEMA = """
create table if not exists documents (
  id integer primary key autoincrement,
  key text not null,
  employee_name text,
  doc_types text,
  size integer default 0,
  uploaded_ts_utc text not null
);
create index if not exists idx_documents_key on documents(key);
"""

@app.on_event("startup")
def ensure_schema():
    con = connect()
    try:
        con.executescript(DOCS_SCHEMA)
        con.commit()
    finally:
        con.close()

# -------------------------------------------------------------------
# R2 / S3 client (Cloudflare R2 friendly)
# -------------------------------------------------------------------
def make_s3_client():
    if not (S3_ENDPOINT and S3_BUCKET and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        # We still create a dummy client to fail loudly on first use with a clear message.
        print("[warn] Missing S3/R2 env vars; /documents endpoints will fail until set.")
    session = boto3.session.Session()
    return session.client(
        "s3",
        endpoint_url=S3_ENDPOINT or None,
        aws_access_key_id=S3_ACCESS_KEY_ID or None,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY or None,
        region_name="auto",  # R2 uses 'auto'
        config=botocore.client.Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},  # important for R2
        ),
        verify=certifi.where(),  # ensure we trust the CA bundle in Render
    )

s3 = make_s3_client()

# -------------------------------------------------------------------
# Health / debug
# -------------------------------------------------------------------
@app.get("/debug/health")
def health():
    # quick DB probe
    db_ok = True
    try:
        con = connect()
        con.execute("select 1")
        con.close()
    except Exception:
        db_ok = False
    return {"ok": True, "db": db_ok}

@app.get("/debug/r2")
def debug_r2():
    try:
        # List buckets is allowed in R2 with account tokens. If your token is
        # bucket-scoped, this may raise AccessDenied—still useful feedback.
        s3.list_buckets()
        return {"ok": True}
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": f"{type(e).__name__}: {e}"},
        )

# -------------------------------------------------------------------
# Employees (kept minimal so existing UI keeps working)
# -------------------------------------------------------------------
@app.get("/employees")
def list_employees(limit: int = 100, offset: int = 0):
    con = connect()
    try:
        rows = [dict(r) for r in con.execute(
            "select * from employees order by name limit ? offset ?", (limit, offset)
        )]
        return {"rows": rows}
    finally:
        con.close()

# -------------------------------------------------------------------
# Documents – List / Sync / Upload
# -------------------------------------------------------------------
@app.get("/documents")
def documents_list(limit: int = 500, prefix: str = ""):
    """
    Lists up to `limit` objects from the configured R2 bucket.
    On error, returns a 500 with explicit detail + traceback tail so we can debug quickly.
    """
    if not (S3_ENDPOINT and S3_BUCKET and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        raise HTTPException(status_code=500, detail="R2 is not configured on the server (missing env).")

    try:
        resp = s3.list_objects_v2(
            Bucket=S3_BUCKET,
            MaxKeys=limit,
            Prefix=prefix or ""
        )
        contents = resp.get("Contents", []) or []
        rows = []
        for o in contents:
            lm = o.get("LastModified")
            rows.append({
                "key": o.get("Key"),
                "size": int(o.get("Size") or 0),
                "last_modified": lm.isoformat() if lm else None,
            })
        return {"rows": rows, "page": 1, "page_size": limit, "total": len(rows)}
    except Exception as e:
        tb = traceback.format_exc()
        return JSONResponse(
            status_code=500,
            content={
                "detail": f"R2 list failed: {type(e).__name__}: {e}",
                "trace": tb[-1500:],  # tail of the traceback for brevity
                "endpoint": S3_ENDPOINT,
                "bucket": S3_BUCKET,
            },
        )

@app.post("/documents/sync")
def documents_sync():
    """
    Simple bucket sync: list objects and record basic metadata locally.
    Useful to populate the UI quickly. Idempotent-ish: we don't dedupe keys here.
    """
    if not (S3_ENDPOINT and S3_BUCKET and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        raise HTTPException(status_code=500, detail="R2 is not configured on the server (missing env).")

    try:
        resp = s3.list_objects_v2(Bucket=S3_BUCKET, MaxKeys=1000)
        items = resp.get("Contents", []) or []
        now_utc = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()
        con = connect()
        try:
            cur = con.cursor()
            for o in items:
                key = o.get("Key")
                size = int(o.get("Size") or 0)
                cur.execute(
                    "insert into documents (key, employee_name, doc_types, size, uploaded_ts_utc) values (?,?,?,?,?)",
                    (key, None, None, size, now_utc)
                )
            con.commit()
        finally:
            con.close()
        return {"synced": len(items)}
    except Exception as e:
        tb = traceback.format_exc()
        return JSONResponse(
            status_code=500,
            content={"detail": f"R2 sync failed: {type(e).__name__}: {e}", "trace": tb[-1500:]},
        )

@app.post("/documents/upload")
async def documents_upload(
    employee_name: Optional[str] = Form(default=None),
    doc_types: Optional[str] = Form(default=None),
    file: UploadFile = File(...),
):
    """
    Uploads a file to R2 with a friendly key. Also records a row in sqlite.
    """
    if not (S3_ENDPOINT and S3_BUCKET and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        raise HTTPException(status_code=500, detail="R2 is not configured on the server (missing env).")

    try:
        raw = await file.read()
        # Build key: 2025-09-01T12-34-56Z__Employee__types__original.ext
        ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
        safe_emp = (employee_name or "").strip().replace(" ", "")
        safe_types = (doc_types or "").strip().replace(" ", "")
        base_name = file.filename or "upload.bin"
        key = f"{ts}__{safe_emp or 'Unknown'}__{safe_types or 'doc'}__{base_name}"

        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=raw,
            ContentType=file.content_type or "application/octet-stream",
        )

        con = connect()
        try:
            con.execute(
                "insert into documents (key, employee_name, doc_types, size, uploaded_ts_utc) values (?,?,?,?,?)",
                (key, employee_name, doc_types, len(raw),
                 datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat())
            )
            con.commit()
        finally:
            con.close()

        return {"ok": True, "key": key, "size": len(raw)}
    except Exception as e:
        tb = traceback.format_exc()
        return JSONResponse(
            status_code=500,
            content={"detail": f"R2 upload failed: {type(e).__name__}: {e}", "trace": tb[-1500:]},
        )

# -------------------------------------------------------------------
# Friendly 405 for bare /
# -------------------------------------------------------------------
@app.get("/")
def root():
    # render pings '/' with HEAD; keep a small text page for humans too
    return {"ok": True, "message": "YHO API", "db_path": DB_PATH}

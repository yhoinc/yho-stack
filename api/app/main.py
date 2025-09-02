import os
import io
import json
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, PlainTextResponse

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

# -----------------------------------------------------------------------------
# Config / paths
# -----------------------------------------------------------------------------
DATA_DIR = os.getenv("DATA_DIR", "/data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_FILE = os.getenv("DB_FILE", "employees_with_company_v2.db")
DB_PATH = os.path.join(DATA_DIR, DB_FILE)

S3_ENDPOINT = (os.getenv("S3_ENDPOINT") or "").strip()
S3_REGION = os.getenv("S3_REGION", "us-east-1")
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID")
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY")
S3_BUCKET = os.getenv("S3_BUCKET", "employee-docs")

# Supabase “S3 via HTTP” endpoints are HTTPS—boto3 wants a hostname without scheme.
def normalize_endpoint(ep: str) -> str:
    ep = ep.strip()
    if ep.startswith("https://"):
        ep = ep[len("https://") :]
    if ep.startswith("http://"):
        ep = ep[len("http://") :]
    return ep

S3_HOST = normalize_endpoint(S3_ENDPOINT) if S3_ENDPOINT else ""

def s3_client():
    if not (S3_HOST and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        raise RuntimeError("S3 credentials/endpoint are not fully configured.")
    return boto3.client(
        "s3",
        region_name=S3_REGION,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        endpoint_url=f"https://{S3_HOST}",
        config=Config(s3={"addressing_style": "path"}),
    )

# -----------------------------------------------------------------------------
# FastAPI app + CORS
# -----------------------------------------------------------------------------
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],           # Render + your Next.js app(s)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,
)

# -----------------------------------------------------------------------------
# SQLite helpers (robust to table name differences)
# -----------------------------------------------------------------------------
EMPLOYEE_LIKE_COLUMNS = {
    "employee_id",
    "name",
    "reference",
    "company",
    "location",
    "position",
    "phone",
    "address",
    "labor_rate",
    "per_diem",
    "deduction",
    "debt",
    "payment_count",
    "apartment_id",
}

def open_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def discover_employee_table(conn: sqlite3.Connection) -> Tuple[str, List[str]]:
    """
    Find a table containing an 'employee_id' column. Return (table_name, column_names).
    Raises if none found.
    """
    cur = conn.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")
    candidates: List[Tuple[str, List[str]]] = []
    for row in cur.fetchall():
        tname: str = row["name"]
        # columns for this table
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info('{tname}')").fetchall()]
        if "employee_id" in cols:
            candidates.append((tname, cols))
    if not candidates:
        raise RuntimeError("No table with an 'employee_id' column was found in the database.")
    # Prefer common names if multiple
    preferred = ["employees", "employee", "staff", "people", "workers"]
    for pref in preferred:
        for tname, cols in candidates:
            if tname.lower() == pref:
                return tname, cols
    return candidates[0]

def dict_from_row(row: sqlite3.Row) -> Dict[str, Any]:
    return {k: row[k] for k in row.keys()}

def filter_employee_payload(payload: Dict[str, Any], table_columns: List[str]) -> Dict[str, Any]:
    """
    Only keep columns that exist in the target table; coerce numeric-like fields if present.
    """
    keep = {}
    for key, val in payload.items():
        if key in table_columns:
            if key in ("labor_rate", "per_diem") and val not in (None, ""):
                try:
                    keep[key] = float(val)
                except Exception:
                    keep[key] = None
            else:
                keep[key] = val
    return keep

# -----------------------------------------------------------------------------
# Employees API
# -----------------------------------------------------------------------------
@app.get("/employees")
def list_employees(limit: int = Query(1000, ge=1, le=10000), offset: int = Query(0, ge=0)):
    try:
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)

            # Build a COALESCE() that only references columns that actually exist
            rate_candidates = [c for c in ("labor_rate","pay_rate","payrate","rate","hourly_rate") if c in cols]
            if rate_candidates:
                # CREATE a SQL expression to strip $ and , then cast to REAL
                # COALESCE will pick the first non-NULL
                coalesce_expr = "COALESCE(" + ", ".join(rate_candidates) + ")"
                rate_sql = f"CAST(REPLACE(REPLACE({coalesce_expr}, '$',''), ',', '') AS REAL) AS labor_rate_display"
            else:
                # no known rate columns; expose NULL
                rate_sql = "NULL AS labor_rate_display"

            total = conn.execute(f"SELECT COUNT(*) AS c FROM '{tname}'").fetchone()["c"]
            rows = conn.execute(
                f"SELECT *, {rate_sql} FROM '{tname}' LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            data = [dict_from_row(r) for r in rows]
            return {"rows": data, "total": total, "limit": limit, "offset": offset, "table": tname}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/employees")
def create_employee(payload: Dict[str, Any]):
    if not isinstance(payload, dict) or not payload.get("employee_id"):
        raise HTTPException(status_code=400, detail="employee_id is required")
    try:
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)
            # keep only existing columns
            data = filter_employee_payload(payload, cols)
            # Build INSERT
            keys = list(data.keys())
            qmarks = ",".join(["?"] * len(keys))
            sql = f"INSERT INTO '{tname}' ({','.join(keys)}) VALUES ({qmarks})"
            conn.execute(sql, tuple(data[k] for k in keys))
            conn.commit()
            return {"ok": True}
    except sqlite3.IntegrityError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.patch("/employees/{employee_id}")
def update_employee(employee_id: str, payload: Dict[str, Any]):
    if not employee_id:
        raise HTTPException(status_code=400, detail="employee_id is required")
    try:
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)
            data = filter_employee_payload(payload, cols)
            if not data:
                return {"ok": True, "updated": 0}
            sets = ", ".join([f"{k}=?" for k in data.keys()])
            sql = f"UPDATE '{tname}' SET {sets} WHERE employee_id=?"
            cur = conn.execute(sql, (*[data[k] for k in data.keys()], employee_id))
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Employee not found")
            return {"ok": True, "updated": cur.rowcount}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# -----------------------------------------------------------------------------
# Documents (S3-compatible – e.g., Supabase Storage S3)
# -----------------------------------------------------------------------------
def require_s3():
    try:
        return s3_client()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"S3 not configured: {e}")

@app.get("/documents")
def list_documents(limit: int = 500):
    """
    Return flat listing of objects in S3_BUCKET (key, size, last_modified).
    """
    s3 = require_s3()
    try:
        paginator = s3.get_paginator("list_objects_v2")
        page_it = paginator.paginate(Bucket=S3_BUCKET, PaginationConfig={"MaxItems": limit})
        items: List[Dict[str, Any]] = []
        for page in page_it:
            for obj in page.get("Contents", []) or []:
                items.append(
                    {
                        "key": obj["Key"],
                        "size": obj.get("Size", 0),
                        "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
                    }
                )
                if len(items) >= limit:
                    break
            if len(items) >= limit:
                break
        return {"rows": items, "total": len(items)}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/documents/upload")
async def upload_document(
    employee_name: str = Form(""),
    doc_types: str = Form(""),
    custom_type: str = Form(""),
    file: UploadFile = File(...),
):
    """
    Upload file -> S3. Key format:
    {sanitized_name}/{type_or_custom}/{original_filename}
    """
    s3 = require_s3()
    try:
        name = (employee_name or "unknown").strip() or "unknown"
        name_key = "_".join(name.split())
        chosen_type = (custom_type or doc_types or "misc").strip() or "misc"

        original = file.filename or "upload.bin"
        key = f"{name_key}/{chosen_type}/{original}"

        body = await file.read()
        s3.put_object(Bucket=S3_BUCKET, Key=key, Body=body, ContentType=file.content_type or "application/octet-stream")
        return {"ok": True, "key": key}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/documents/{key:path}/download")
def download_document(key: str):
    s3 = require_s3()
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        content_type = obj.get("ContentType") or "application/octet-stream"
        stream = obj["Body"].read()
        return StreamingResponse(io.BytesIO(stream), media_type=content_type,
                                 headers={"Content-Disposition": f'inline; filename="{os.path.basename(key)}"'})
    except ClientError as e:
        code = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 500)
        raise HTTPException(status_code=code, detail=str(e))

@app.post("/documents/sync")
def sync_documents():
    """
    Placeholder: In a future step, you can sync S3 keys into a DB table.
    For now, just return ok so the button doesn't 500.
    """
    return {"ok": True}

# -----------------------------------------------------------------------------
# Health / debug
# -----------------------------------------------------------------------------
@app.get("/debug/health")
def health():
    try:
        ok_db = os.path.exists(DB_PATH)
        return {"ok": True, "db": ok_db, "db_path": DB_PATH}
    except Exception as e:
        return PlainTextResponse(str(e), status_code=500)


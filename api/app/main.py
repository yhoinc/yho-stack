from __future__ import annotations

import os
import re
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterable, List, Optional, Tuple

import boto3
from botocore.config import Config
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# =========================================================
# -------------------- Environment ------------------------
# =========================================================

# --- DB (SQLite) ---
DATA_DIR = os.getenv("DATA_DIR", "/data")
DB_PATH = os.getenv("DB_PATH", os.path.join(DATA_DIR, "employees_with_company_v2.db"))

# --- Supabase S3-compatible storage (for documents) ---
S3_ENDPOINT = os.getenv("S3_ENDPOINT", "").strip().rstrip("/")
S3_REGION = os.getenv("S3_REGION", "us-east-1").strip() or "us-east-1"
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID", "")
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY", "")
S3_BUCKET = os.getenv("S3_BUCKET", "employee-docs")

# --- CORS ---
FRONTEND_ORIGINS = [
    o.strip()
    for o in os.getenv("FRONTEND_ORIGINS", "").split(",")
    if o.strip()
] or [
    "https://yho-stack.onrender.com",
    "https://yho-stack-1.onrender.com",
]

# =========================================================
# -------------------- FastAPI app ------------------------
# =========================================================

app = FastAPI(title="YHO Stack API (Employees, Payroll, Documents)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
    max_age=600,
)

# =========================================================
# ---------------------- SQLite ---------------------------
# =========================================================

def db_exists(path: str) -> bool:
    try:
        return os.path.exists(path) and os.path.getsize(path) > 0
    except Exception:
        return False

@contextmanager
def db_conn(path: str) -> Iterable[sqlite3.Connection]:
    if not db_exists(path):
        raise HTTPException(status_code=500, detail=f"DB not found at {path}")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name)=lower(?)",
        (name,),
    )
    return cur.fetchone() is not None

def pick_first_existing_table(conn: sqlite3.Connection, candidates: List[str]) -> Optional[str]:
    for t in candidates:
        if table_exists(conn, t):
            return t
    return None

def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> List[Dict[str, Any]]:
    return [dict(r) for r in rows]

# =========================================================
# --------------------- Storage (S3) ----------------------
# =========================================================

def storage_ready() -> bool:
    return bool(S3_ENDPOINT and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET)

def require_storage_ready():
    if not storage_ready():
        raise HTTPException(status_code=500, detail="Storage credentials not configured")

_s3 = boto3.client(
    "s3",
    region_name=S3_REGION,
    endpoint_url=S3_ENDPOINT if S3_ENDPOINT.startswith("http") else (f"https://{S3_ENDPOINT}" if S3_ENDPOINT else None),
    aws_access_key_id=S3_ACCESS_KEY_ID or None,
    aws_secret_access_key=S3_SECRET_ACCESS_KEY or None,
    config=Config(
        s3={"addressing_style": "path"},
        retries={"max_attempts": 3, "mode": "standard"},
        signature_version="s3v4",
    ),
)

_slug_re = re.compile(r"[^a-z0-9]+")
def slugify(s: str) -> str:
    s = s.lower().strip()
    s = _slug_re.sub("-", s)
    return s.strip("-") or "file"

def file_ext(filename: str) -> str:
    p = filename.rfind(".")
    return filename[p + 1 :].lower() if p != -1 else "bin"

# =========================================================
# --------------------- Pydantic models -------------------
# =========================================================

class HealthOut(BaseModel):
    ok: bool
    db: bool
    storage: bool

class PageOut(BaseModel):
    rows: List[Dict[str, Any]]
    page: int
    page_size: int
    total: int

class DocRow(BaseModel):
    key: str
    size: int
    last_modified: Optional[str] = None
    url: Optional[str] = None

class DocList(BaseModel):
    rows: List[DocRow]
    total: int

# =========================================================
# ------------------------- Routes ------------------------
# =========================================================

@app.get("/debug/health", response_model=HealthOut)
def debug_health():
    return HealthOut(ok=True, db=db_exists(DB_PATH), storage=storage_ready())

# --------------- Employees -----------------

@app.get("/employees", response_model=PageOut)
def list_employees(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=1000),
    q: Optional[str] = Query(None, description="Search text"),
):
    """
    Defensive implementation that works with a few likely table shapes.
    We try to find an employees-like table and do a simple (optional) text search.
    """
    with db_conn(DB_PATH) as conn:
        # Guess a table to read from
        table = pick_first_existing_table(
            conn,
            [
                "employees",
                "employee",
                "vw_employees",
                "employee_view",
            ],
        )
        if not table:
            # Fall back: list all tables to aid debugging
            tbls = rows_to_dicts(conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
            raise HTTPException(
                status_code=404,
                detail=f"No employees table found. Existing tables: {[t['name'] for t in tbls]}",
            )

        # Determine columns to select (avoid huge SELECT *)
        cols = rows_to_dicts(
            conn.execute(f"PRAGMA table_info('{table}')")
        )
        col_names = [c["name"] for c in cols] or ["*"]
        select_cols = ", ".join([f'"{c}"' for c in col_names])

        where = ""
        args: List[Any] = []
        if q:
            # Try friendly columns if present
            like_cols = [c for c in ["full_name", "first_name", "last_name", "name"] if c in col_names]
            if like_cols:
                like_bits = " OR ".join([f'LOWER("{c}") LIKE ?' for c in like_cols])
                where = f" WHERE {like_bits} "
                args.extend([f"%{q.lower()}%"] * len(like_cols))

        # Get total
        total_sql = f"SELECT COUNT(1) AS cnt FROM '{table}'{where}"
        total = conn.execute(total_sql, args).fetchone()["cnt"]

        # Page
        offset = (page - 1) * limit
        data_sql = f"SELECT {select_cols} FROM '{table}'{where} ORDER BY rowid LIMIT ? OFFSET ?"
        rows = rows_to_dicts(conn.execute(data_sql, (*args, limit, offset)).fetchall())

        return PageOut(rows=rows, page=page, page_size=limit, total=int(total))

# --------------- Payroll (summary) ---------------

@app.get("/payroll/summary/payout_by_employee", response_model=PageOut)
def payroll_summary(limit: int = Query(500, ge=1, le=5000)):
    """
    Returns aggregated payout by employee if a plausible payroll table exists.
    Tries common table/column names, and degrades gracefully if not found.
    """
    with db_conn(DB_PATH) as conn:
        # Try to locate a payroll/payments table
        payroll_table = pick_first_existing_table(
            conn,
            ["payroll", "payments", "employee_payments", "vw_payroll"],
        )
        if not payroll_table:
            raise HTTPException(status_code=404, detail="No payroll table found")

        # Find likely columns
        cols = rows_to_dicts(conn.execute(f"PRAGMA table_info('{payroll_table}')"))
        names = {c["name"].lower() for c in cols}

        # Guess amount and employee id/name columns
        amount_col = next((c for c in ["amount", "net_pay", "payout", "pay"] if c in names), None)
        emp_id_col = next((c for c in ["employee_id", "emp_id", "id_employee"] if c in names), None)
        emp_name_col = next((c for c in ["employee_name", "full_name", "name"] if c in names), None)

        if not amount_col or not (emp_id_col or emp_name_col):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot infer columns in {payroll_table}. Need amount + employee id/name.",
            )

        # Build group-by
        if emp_name_col:
            group_expr = f'"{emp_name_col}"'
            select_label = "employee"
        else:
            group_expr = f'"{emp_id_col}"'
            select_label = "employee_id"

        sql = f"""
            SELECT {group_expr} AS {select_label}, SUM("{amount_col}") AS total_payout
            FROM "{payroll_table}"
            GROUP BY {group_expr}
            ORDER BY total_payout DESC
            LIMIT ?
        """
        rows = rows_to_dicts(conn.execute(sql, (limit,)).fetchall())

        # Normalize return shape
        return PageOut(rows=rows, page=1, page_size=limit, total=len(rows))

# --------------- Documents (Supabase Storage via S3) ---------------

class DocUploadOut(DocRow):
    pass

@app.get("/documents", response_model=DocList)
def documents_list(prefix: str = "", limit: int = Query(500, ge=1, le=1000)):
    require_storage_ready()
    try:
        rows: List[DocRow] = []
        resp = _s3.list_objects_v2(Bucket=S3_BUCKET, Prefix=prefix or "", MaxKeys=min(limit, 1000))
        while True:
            for obj in resp.get("Contents", []):
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
            resp = _s3.list_objects_v2(
                Bucket=S3_BUCKET,
                Prefix=prefix or "",
                ContinuationToken=resp["NextContinuationToken"],
                MaxKeys=min(limit - len(rows), 1000),
            )
        return DocList(rows=rows, total=len(rows))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"S3 list error: {e}")

@app.post("/documents/upload", response_model=DocUploadOut)
async def documents_upload(
    employee_name: str = Form(""),
    doc_types: Optional[List[str]] = Form(default=None),
    file: UploadFile = File(...),
):
    require_storage_ready()
    try:
        name_part = slugify(employee_name or "employee")
        types_part = "-".join([slugify(t) for t in (doc_types or [])]) or "doc"
        ts = int(time.time())
        ext = file_ext(file.filename or "bin")
        key = f"{name_part}_{types_part}_{ts}.{ext}"

        data = await file.read()
        _s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=data,
            ContentType=file.content_type or "application/octet-stream",
        )
        url = _s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=3600,
        )
        return DocUploadOut(key=key, size=len(data), url=url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"S3 upload error: {e}")

@app.get("/documents/signed-url", response_model=DocRow)
def documents_signed_url(key: str):
    require_storage_ready()
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

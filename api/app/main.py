import os
import sqlite3
import datetime
import uuid
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Body, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------- R2 (S3) ----------
import boto3
from botocore.config import Config as BotoConfig

# ----------------- Config -----------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "employees_with_company_v2.db"))

# R2 / S3 env (required for doc storage)
S3_ENDPOINT = os.environ.get("S3_ENDPOINT")               # e.g. https://<accountid>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID")
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY")
S3_BUCKET = os.environ.get("S3_BUCKET")                   # yho-employee-docs

# ----------------- App --------------------
app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------- DB helpers -------------
def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def execmany(con: sqlite3.Connection, sql: str, rows: List[tuple]):
    cur = con.cursor()
    cur.executemany(sql, rows)
    cur.close()

# ----------------- Schema -----------------
SCHEMA = """
create table if not exists employees (
  employee_id   text primary key,
  reference     text,
  company       text,
  location      text,
  name          text,
  phone         text,
  address       text,
  position      text,
  labor_rate    real,
  deduction     text,
  debt          text,
  payment_count text,
  apartment_id  text,
  per_diem      real
);

create table if not exists payroll_runs (
  id              integer primary key autoincrement,
  run_key         text not null unique,
  run_ts_utc      text not null,
  scope           text not null,
  company         text,
  location        text,
  note            text
);

create table if not exists payroll_items (
  id              integer primary key autoincrement,
  run_id          integer not null references payroll_runs(id) on delete cascade,
  employee_id     text not null,
  name            text,
  reference       text,
  company         text,
  location        text,
  position        text,
  labor_rate      real,
  week1_hours     real default 0,
  week2_hours     real default 0,
  total_hours     real default 0,
  check_total     real default 0
);

create table if not exists commissions (
  id               integer primary key autoincrement,
  run_id           integer not null references payroll_runs(id) on delete cascade,
  beneficiary      text not null,
  per_hour_rate    real not null,
  source_hours     real not null,
  total_commission real not null
);

create index if not exists idx_payroll_items_run on payroll_items(run_id);
create index if not exists idx_commissions_run on commissions(run_id);
create index if not exists idx_payroll_runs_ts on payroll_runs(run_ts_utc);

-- documents table tracks objects stored in R2
create table if not exists documents (
  id             integer primary key autoincrement,
  key            text not null,            -- R2 object key (unique)
  employee_name  text,
  employee_id    text,
  doc_types      text,                     -- comma separated tags
  size           integer,
  content_type   text,
  uploaded_at    text                      -- iso ts (either from R2 or created here)
);
"""

DOCS_UNIQUE = """
create unique index if not exists ux_documents_key on documents(key);
"""

@app.on_event("startup")
def ensure_schema():
    con = connect()
    try:
        con.executescript(SCHEMA)
        con.executescript(DOCS_UNIQUE)
        con.commit()
    finally:
        con.close()

# ----------------- Health -----------------
@app.get("/debug/health")
def health():
    return {"ok": True, "db": os.path.exists(DB_PATH)}

# ----------------- Employees (simple) -----
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

# ----------------- Payroll (existing APIs you already used remain unchanged) ----
# (Omitted here for brevity; keep your existing payroll endpoints exactly as-is.)

# ----------------- R2 / S3 helpers -----------------
def require_r2_env():
    missing = []
    if not S3_ENDPOINT: missing.append("S3_ENDPOINT")
    if not S3_ACCESS_KEY_ID: missing.append("S3_ACCESS_KEY_ID")
    if not S3_SECRET_ACCESS_KEY: missing.append("S3_SECRET_ACCESS_KEY")
    if not S3_BUCKET: missing.append("S3_BUCKET")
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Missing R2/S3 env: {', '.join(missing)}"
        )

def r2_client():
    require_r2_env()
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        region_name="auto",
        config=BotoConfig(s3={"addressing_style": "virtual"})
    )

# ----------------- Documents: Sync from R2 to DB -----------------
def r2_list_all(prefix: Optional[str] = None):
    cl = r2_client()
    kw: Dict[str, Any] = {"Bucket": S3_BUCKET, "MaxKeys": 1000}
    if prefix:
        kw["Prefix"] = prefix

    while True:
        resp = cl.list_objects_v2(**kw)
        for item in resp.get("Contents", []):
            yield {
                "Key": item["Key"],
                "Size": int(item.get("Size") or 0),
                "LastModified": item.get("LastModified").isoformat() if item.get("LastModified") else None
            }
        if resp.get("IsTruncated"):
            kw["ContinuationToken"] = resp["NextContinuationToken"]
        else:
            break

def ensure_document_row(con: sqlite3.Connection, key: str, size: Optional[int], last_modified: Optional[str]):
    # Insert only if not exists (do not overwrite user-set metadata)
    con.execute(
        """
        insert into documents (key, size, uploaded_at)
        select ?, ?, ?
        where not exists (select 1 from documents where key = ?)
        """,
        (key, size, last_modified or datetime.datetime.utcnow().isoformat(), key)
    )

@app.post("/documents/sync")
def sync_documents(payload: Dict[str, Any] = Body(default={})):
    prefix = payload.get("prefix")
    discovered = 0
    inserted = 0
    con = connect()
    try:
        for obj in r2_list_all(prefix=prefix):
            discovered += 1
            cur = con.execute("select 1 from documents where key = ?", (obj["Key"],))
            if not cur.fetchone():
                ensure_document_row(con, obj["Key"], obj["Size"], obj["LastModified"])
                inserted += 1
        con.commit()
        return {"ok": True, "discovered": discovered, "inserted": inserted}
    finally:
        con.close()

# ----------------- Documents: list/search -----------------
@app.get("/documents")
def list_documents(q: Optional[str] = None, page: int = 1, page_size: int = 50):
    page = max(page, 1)
    offset = (page - 1) * page_size
    con = connect()
    try:
        if q:
            like = f"%{q}%"
            rows = [dict(r) for r in con.execute(
                """
                select * from documents
                where key like ? or ifnull(employee_name,'') like ? or ifnull(doc_types,'') like ?
                order by uploaded_at desc, key
                limit ? offset ?
                """,
                (like, like, like, page_size, offset)
            )]
            total = con.execute(
                """
                select count(*) as c from documents
                where key like ? or ifnull(employee_name,'') like ? or ifnull(doc_types,'') like ?
                """, (like, like, like)
            ).fetchone()["c"]
        else:
            rows = [dict(r) for r in con.execute(
                "select * from documents order by uploaded_at desc, key limit ? offset ?",
                (page_size, offset)
            )]
            total = con.execute("select count(*) as c from documents").fetchone()["c"]
        return {"rows": rows, "page": page, "page_size": page_size, "total": total}
    finally:
        con.close()

# ----------------- Documents: save metadata (when front-end already has key) ----
@app.post("/documents/save")
def save_document(payload: Dict[str, Any] = Body(...)):
    key = payload.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="key required")
    employee_name = payload.get("employee_name")
    employee_id = payload.get("employee_id")
    doc_types = payload.get("doc_types") or []
    if isinstance(doc_types, list):
        doc_types = ",".join(doc_types)
    size = payload.get("size")
    content_type = payload.get("content_type")

    con = connect()
    try:
        # upsert by key
        cur = con.execute("select id from documents where key = ?", (key,))
        row = cur.fetchone()
        if row:
            con.execute(
                """
                update documents set
                  employee_name = coalesce(?, employee_name),
                  employee_id   = coalesce(?, employee_id),
                  doc_types     = coalesce(?, doc_types),
                  size          = coalesce(?, size),
                  content_type  = coalesce(?, content_type)
                where key = ?
                """,
                (employee_name, employee_id, doc_types, size, content_type, key)
            )
        else:
            con.execute(
                """
                insert into documents (key, employee_name, employee_id, doc_types, size, content_type, uploaded_at)
                values (?, ?, ?, ?, ?, ?, ?)
                """,
                (key, employee_name, employee_id, doc_types, size, content_type,
                 datetime.datetime.utcnow().isoformat())
            )
        con.commit()
        return {"ok": True}
    finally:
        con.close()

# ----------------- Documents: presign upload & download -----------------
@app.post("/documents/presign/upload")
def presign_upload(payload: Dict[str, Any] = Body(...)):
    """Generate a presigned PUT url for uploading a file to R2."""
    require_r2_env()
    key = payload.get("key")
    if not key:
        # default key if not supplied
        key = f"uploads/{datetime.datetime.utcnow().date().isoformat()}/{uuid.uuid4().hex}"
        if payload.get("filename"):
            key += "_" + payload["filename"]

    content_type = payload.get("content_type") or "application/octet-stream"
    cl = r2_client()
    try:
        url = cl.generate_presigned_url(
            ClientMethod="put_object",
            Params={"Bucket": S3_BUCKET, "Key": key, "ContentType": content_type},
            ExpiresIn=900  # 15 min
        )
        return {"key": key, "url": url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/documents/presign/download")
def presign_download(payload: Dict[str, Any] = Body(...)):
    """Generate a presigned GET url for downloading a file from R2."""
    require_r2_env()
    key = payload.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="key required")
    cl = r2_client()
    try:
        url = cl.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=600
        )
        return {"url": url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

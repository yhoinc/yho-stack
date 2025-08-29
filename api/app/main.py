import os
import io
import time
import uuid
import pathlib
import datetime
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, Body, HTTPException, UploadFile, File, Query
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError


# ------------------------------------------------------------------------------
# Paths & environment
# ------------------------------------------------------------------------------

BASE_DIR = pathlib.Path(__file__).resolve().parent

# DB location (mounted disk friendly)
DB_PATH = os.environ.get("DB_PATH", "employees_with_company_v2.db")
if not os.path.isabs(DB_PATH):
    DB_PATH = str((BASE_DIR / DB_PATH).resolve())

DATA_DIR = os.environ.get("DATA_DIR", "/data")
if DATA_DIR and not os.path.isabs(DB_PATH):
    # prefer /data when present
    DB_PATH = str(pathlib.Path(DATA_DIR) / pathlib.Path(DB_PATH).name)

# S3 / R2
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "").strip()
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "").strip()
S3_BUCKET = os.environ.get("S3_BUCKET", "").strip()
S3_REGION = os.environ.get("S3_REGION", "auto")  # "auto" is fine for R2

print(f"[startup] DB_PATH={DB_PATH}")
print(f"[startup] S3_ENDPOINT={S3_ENDPOINT!r}  BUCKET={S3_BUCKET!r}")

# ------------------------------------------------------------------------------
# FastAPI app
# ------------------------------------------------------------------------------

app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten in prod (set your web origin)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------------------
# SQLite helpers
# ------------------------------------------------------------------------------

def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def execmany(con: sqlite3.Connection, sql: str, rows: List[tuple]) -> None:
    cur = con.cursor()
    cur.executemany(sql, rows)
    cur.close()


# ------------------------------------------------------------------------------
# Schema
# ------------------------------------------------------------------------------

SCHEMA = """
-- Employees table (already exists in your DB, kept for safety)
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

-- Payroll runs
create table if not exists payroll_runs (
  id          integer primary key autoincrement,
  run_key     text not null unique,
  run_ts_utc  text not null,
  scope       text not null,       -- "all" | "by"
  company     text,
  location    text,
  note        text
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
create index if not exists idx_runs_ts on payroll_runs(run_ts_utc);

-- Documents catalog (R2 index)
create table if not exists documents (
  id            integer primary key autoincrement,
  s3_key        text not null unique,
  file_name     text not null,
  employee_name text,
  doc_type      text,         -- comma separated tags
  size          integer,
  content_type  text,
  uploaded_ts   text not null
);
"""

@app.on_event("startup")
def ensure_schema() -> None:
    # Ensure db file exists & schema ready
    pathlib.Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    try:
        con.executescript(SCHEMA)
        con.commit()
        print("[startup] schema ok")
    finally:
        con.close()


# ------------------------------------------------------------------------------
# Health / root
# ------------------------------------------------------------------------------

@app.get("/")
def root():
    return {"ok": True, "db": bool(pathlib.Path(DB_PATH).exists())}

@app.get("/debug/health")
def health():
    return {"ok": True, "ts": time.time()}


# ------------------------------------------------------------------------------
# Employees
# ------------------------------------------------------------------------------

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

@app.get("/employees/{employee_id}")
def get_employee(employee_id: str):
    con = connect()
    try:
        row = con.execute(
            "select * from employees where employee_id = ?", (employee_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        return dict(row)
    finally:
        con.close()

@app.post("/employees")
def create_employee(payload: Dict[str, Any] = Body(...)):
    con = connect()
    try:
        if not payload:
            raise HTTPException(status_code=400, detail="empty")
        keys, vals, qm = [], [], []
        for k, v in payload.items():
            keys.append(k); vals.append(v); qm.append("?")
        sql = f"insert into employees ({', '.join(keys)}) values ({', '.join(qm)})"
        cur = con.cursor()
        cur.execute(sql, tuple(vals))
        con.commit()
        return {"ok": True, "employee_id": payload.get("employee_id")}
    finally:
        con.close()

@app.patch("/employees/{employee_id}")
def patch_employee(employee_id: str, payload: Dict[str, Any] = Body(...)):
    if not payload:
        return {"ok": True}
    con = connect()
    try:
        sets, vals = [], []
        for k, v in payload.items():
            sets.append(f"{k} = ?"); vals.append(v)
        vals.append(employee_id)
        sql = f"update employees set {', '.join(sets)} where employee_id = ?"
        cur = con.cursor()
        cur.execute(sql, tuple(vals))
        con.commit()
        return {"ok": True}
    finally:
        con.close()


# ------------------------------------------------------------------------------
# Payroll: runs + summaries
# ------------------------------------------------------------------------------

@app.post("/payroll/runs")
def create_payroll_run(payload: Dict[str, Any] = Body(...)):
    scope = payload.get("scope") or "all"
    company = payload.get("company")
    location = payload.get("location")
    note = payload.get("note")
    items = payload.get("items") or []
    comm = payload.get("commission") or {"beneficiary": "danny", "per_hour_rate": 0.50}

    run_ts_utc = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()
    run_key = f"{run_ts_utc}-{uuid.uuid4().hex[:8]}"

    prepared: List[tuple] = []
    total_hours_sum = 0.0
    for it in items:
        w1 = float(it.get("week1_hours") or 0)
        w2 = float(it.get("week2_hours") or 0)
        hrs = w1 + w2
        rate = float(it.get("labor_rate") or 0)
        total = rate * hrs
        total_hours_sum += hrs
        prepared.append((
            it.get("employee_id"),
            it.get("name"),
            it.get("reference"),
            it.get("company"),
            it.get("location"),
            it.get("position"),
            rate, w1, w2, hrs, total
        ))

    ben = comm.get("beneficiary") or "danny"
    per_hr = float(comm.get("per_hour_rate") or 0.50)
    commission_total = per_hr * total_hours_sum

    con = connect()
    try:
        cur = con.cursor()
        cur.execute(
            "insert into payroll_runs (run_key, run_ts_utc, scope, company, location, note) values (?,?,?,?,?,?)",
            (run_key, run_ts_utc, scope, company, location, note)
        )
        run_id = cur.lastrowid

        execmany(con,
            """insert into payroll_items
               (run_id, employee_id, name, reference, company, location, position,
                labor_rate, week1_hours, week2_hours, total_hours, check_total)
               values (?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(run_id,)+row for row in prepared]
        )

        cur.execute(
            "insert into commissions (run_id, beneficiary, per_hour_rate, source_hours, total_commission) values (?,?,?,?,?)",
            (run_id, ben, per_hr, total_hours_sum, commission_total)
        )

        con.commit()
        return {
            "run_id": run_id,
            "run_key": run_key,
            "commission": {
                "beneficiary": ben,
                "per_hour_rate": per_hr,
                "source_hours": total_hours_sum,
                "total_commission": commission_total
            }
        }
    finally:
        con.close()


def _summary_query(base_where: str,
                   date_from: Optional[str],
                   date_to: Optional[str],
                   extra_where: str = "",
                   params: Optional[List[Any]] = None) -> Tuple[str, List[Any]]:
    q = base_where
    p: List[Any] = [] if params is None else list(params)
    if date_from:
        q += " and pr.run_ts_utc >= ?"; p.append(date_from)
    if date_to:
        q += " and pr.run_ts_utc <= ?"; p.append(date_to)
    q += extra_where
    return q, p

@app.get("/payroll/summary/hours_by_company")
def hours_by_company(date_from: Optional[str] = None, date_to: Optional[str] = None):
    con = connect()
    try:
        base = """
        select pr.company as company,
               date(pr.run_ts_utc) as run_date,
               sum(pi.total_hours) as total_hours
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        q, p = _summary_query(base, date_from, date_to,
                              " group by pr.company, date(pr.run_ts_utc) order by run_date desc, company")
        rows = [dict(r) for r in con.execute(q, p)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/hours_by_employee")
def hours_by_employee(date_from: Optional[str] = None, date_to: Optional[str] = None, company: Optional[str] = None):
    con = connect()
    try:
        base = """
        select pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc) as run_date,
               sum(pi.total_hours) as total_hours
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        extra = ""
        p: List[Any] = []
        if company:
            extra = " and pr.company = ?"; p.append(company)
        q, p2 = _summary_query(base, date_from, date_to,
                               " group by pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc)"
                               " order by run_date desc, company, pi.name", p)
        rows = [dict(r) for r in con.execute(q, p2)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/payout_by_company")
def payout_by_company(date_from: Optional[str] = None, date_to: Optional[str] = None):
    con = connect()
    try:
        base = """
        select pr.company, date(pr.run_ts_utc) as run_date,
               sum(pi.check_total) as total_payout
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        q, p = _summary_query(base, date_from, date_to,
                              " group by pr.company, date(pr.run_ts_utc) order by run_date desc, company")
        rows = [dict(r) for r in con.execute(q, p)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/payout_by_employee")
def payout_by_employee(date_from: Optional[str] = None, date_to: Optional[str] = None, company: Optional[str] = None):
    con = connect()
    try:
        base = """
        select pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc) as run_date,
               sum(pi.check_total) as total_paid
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        extra = ""
        p: List[Any] = []
        if company:
            extra = " and pr.company = ?"; p.append(company)
        q, p2 = _summary_query(base, date_from, date_to,
                               " group by pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc)"
                               " order by run_date desc, company, pi.name", p)
        rows = [dict(r) for r in con.execute(q, p2)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/commissions")
def commissions_summary(date_from: Optional[str] = None, date_to: Optional[str] = None, beneficiary: Optional[str] = None):
    con = connect()
    try:
        base = """
        select c.beneficiary, date(pr.run_ts_utc) as run_date,
               c.per_hour_rate, c.source_hours, c.total_commission
        from commissions c
        join payroll_runs pr on pr.id = c.run_id
        where 1=1
        """
        extra = ""
        p: List[Any] = []
        if beneficiary:
            extra = " and c.beneficiary = ?"; p.append(beneficiary)
        q, p2 = _summary_query(base, date_from, date_to, " order by run_date desc", p)
        rows = [dict(r) for r in con.execute(q, p2)]
        return {"rows": rows}
    finally:
        con.close()


# ------------------------------------------------------------------------------
# R2 / S3 client (path-style addressing!)
# ------------------------------------------------------------------------------

_s3_client = None

def s3():
    """
    Cloudflare R2 needs PATH-STYLE addressing to avoid TLS name mismatch:
        https://<accountid>.r2.cloudflarestorage.com/<bucket>/<key>
    """
    global _s3_client
    if _s3_client is None:
        if not (S3_ENDPOINT and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET):
            raise HTTPException(status_code=500, detail="R2/S3 not configured")
        _s3_client = boto3.client(
            "s3",
            endpoint_url=S3_ENDPOINT,
            aws_access_key_id=S3_ACCESS_KEY_ID,
            aws_secret_access_key=S3_SECRET_ACCESS_KEY,
            region_name=S3_REGION,
            config=BotoConfig(
                signature_version="s3v4",
                s3={"addressing_style": "path"}  # <<==== FIX
            ),
        )
    return _s3_client


# ------------------------------------------------------------------------------
# Documents
# ------------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()

@app.get("/documents")
def documents_list(
    limit: int = Query(50, ge=1, le=500),
    page: int = Query(1, ge=1),
    q: Optional[str] = None
):
    con = connect()
    try:
        where = "1=1"
        params: List[Any] = []
        if q:
            where += " and (file_name like ? or employee_name like ? or doc_type like ?)"
            like = f"%{q}%"; params += [like, like, like]
        total = con.execute(f"select count(*) as c from documents where {where}", params).fetchone()["c"]
        offset = (page - 1) * limit
        rows = [dict(r) for r in con.execute(
            f"select * from documents where {where} order by uploaded_ts desc limit ? offset ?",
            params + [limit, offset]
        )]
        return {"rows": rows, "page": page, "page_size": limit, "total": total}
    finally:
        con.close()

@app.post("/documents/upload")
def documents_upload(
    employee_name: Optional[str] = None,
    doc_type: Optional[str] = None,
    file: UploadFile = File(...)
):
    if not file:
        raise HTTPException(status_code=400, detail="file required")

    # Construct key: employee/ts_filename
    base_name = pathlib.Path(file.filename or "upload.bin").name
    safe_emp = (employee_name or "unknown").strip().replace("/", "_")
    stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    key = f"{safe_emp}/{stamp}__{base_name}"

    try:
        s3().upload_fileobj(
            Fileobj=file.file,
            Bucket=S3_BUCKET,
            Key=key,
            ExtraArgs={"ContentType": file.content_type or "application/octet-stream"},
        )
    except (BotoCoreError, ClientError) as e:
        raise HTTPException(status_code=500, detail=f"R2 upload failed: {e}")

    con = connect()
    try:
        con.execute(
            "insert or ignore into documents (s3_key, file_name, employee_name, doc_type, size, content_type, uploaded_ts)"
            " values (?,?,?,?,?,?,?)",
            (key, base_name, employee_name, doc_type, None, file.content_type, _now_iso())
        )
        con.commit()
        return {"ok": True, "key": key}
    finally:
        con.close()

@app.post("/documents/sync")
def documents_sync():
    """
    Read current objects in the bucket and upsert into documents table.
    """
    try:
        client = s3()
        paginator = client.get_paginator("list_objects_v2")
        added = 0
        con = connect()
        try:
            for page in paginator.paginate(Bucket=S3_BUCKET):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    size = int(obj.get("Size") or 0)
                    # Derive basic metadata from key (best-effort)
                    file_name = pathlib.Path(key).name
                    employee_name = key.split("/", 1)[0] if "/" in key else None
                    con.execute(
                        "insert or ignore into documents (s3_key, file_name, employee_name, doc_type, size, content_type, uploaded_ts)"
                        " values (?,?,?,?,?,?,?)",
                        (key, file_name, employee_name, None, size, None, _now_iso())
                    )
                    added += 1
            con.commit()
        finally:
            con.close()
        return {"ok": True, "added_or_seen": added}
    except (BotoCoreError, ClientError) as e:
        raise HTTPException(status_code=500, detail=f"R2 list error: {e}")

@app.get("/documents/{doc_id}/download")
def documents_download(doc_id: int):
    con = connect()
    try:
        row = con.execute("select * from documents where id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
    finally:
        con.close()

    key = row["s3_key"]
    try:
        obj = s3().get_object(Bucket=S3_BUCKET, Key=key)
        stream = obj["Body"]
        media_type = obj.get("ContentType") or "application/octet-stream"
        return StreamingResponse(stream, media_type=media_type,
                                 headers={"Content-Disposition": f'inline; filename="{row["file_name"]}"'})
    except (BotoCoreError, ClientError) as e:
        raise HTTPException(status_code=500, detail=f"R2 get error: {e}")

@app.delete("/documents/{doc_id}")
def documents_delete(doc_id: int):
    con = connect()
    try:
        row = con.execute("select * from documents where id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        key = row["s3_key"]
        try:
            s3().delete_object(Bucket=S3_BUCKET, Key=key)
        except (BotoCoreError, ClientError) as e:
            raise HTTPException(status_code=500, detail=f"R2 delete error: {e}")
        con.execute("delete from documents where id = ?", (doc_id,))
        con.commit()
        return {"ok": True}
    finally:
        con.close()

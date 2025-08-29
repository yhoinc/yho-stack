import os
import io
import re
import uuid
import pathlib
import sqlite3
import datetime
import mimetypes
from typing import Any, Dict, List, Optional

import boto3
from botocore.config import Config as BotoConfig
from fastapi import FastAPI, Body, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# =========================
# Config
# =========================
BASE_DIR = pathlib.Path(__file__).resolve().parent

# --- SQLite (employees + payroll) ---
DB_PATH = os.environ.get("DB_PATH", "employees_with_company_v2.db")
if not os.path.isabs(DB_PATH):
    DB_PATH = str(BASE_DIR / DB_PATH)

# --- R2 / S3 style storage ---
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "").strip()  # e.g. https://<accountid>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "").strip()
S3_BUCKET = os.environ.get("S3_BUCKET", "").strip()
S3_REGION = os.environ.get("S3_REGION", "auto")  # R2 accepts “auto”

# =========================
# App
# =========================
app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# DB helpers
# =========================
def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def execmany(con: sqlite3.Connection, sql: str, rows: List[tuple]):
    cur = con.cursor()
    cur.executemany(sql, rows)
    cur.close()

# =========================
# Schema ensure (payroll)
# =========================
PAYROLL_SCHEMA = """
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
"""

@app.on_event("startup")
def ensure_schema():
    con = connect()
    try:
        con.executescript(PAYROLL_SCHEMA)
        con.commit()
    finally:
        con.close()

# =========================
# Employees (minimal)
# =========================
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
        row = con.execute("select * from employees where employee_id = ?", (employee_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        return dict(row)
    finally:
        con.close()

@app.post("/employees")
def create_employee(payload: Dict[str, Any] = Body(...)):
    con = connect()
    try:
        keys, vals, q = [], [], []
        for k, v in payload.items():
            keys.append(k); vals.append(v); q.append("?")
        sql = f"insert into employees ({', '.join(keys)}) values ({', '.join(q)})"
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
        con.execute(sql, tuple(vals))
        con.commit()
        return {"ok": True}
    finally:
        con.close()

# =========================
# Payroll
# =========================
class PayrollItemIn(BaseModel):
    employee_id: str
    name: Optional[str] = None
    reference: Optional[str] = None
    company: Optional[str] = None
    location: Optional[str] = None
    position: Optional[str] = None
    labor_rate: float = 0
    week1_hours: float = 0
    week2_hours: float = 0

class PayrollRunIn(BaseModel):
    scope: str = "all"
    company: Optional[str] = None
    location: Optional[str] = None
    note: Optional[str] = None
    items: List[PayrollItemIn] = []
    commission: Optional[Dict[str, Any]] = None  # {"beneficiary":"danny","per_hour_rate":0.50}

@app.post("/payroll/runs")
def create_payroll_run(payload: PayrollRunIn):
    scope = payload.scope or "all"
    company = payload.company
    location = payload.location
    note = payload.note
    items = payload.items or []
    comm = payload.commission or {"beneficiary": "danny", "per_hour_rate": 0.50}

    run_ts_utc = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()
    run_key = f"{run_ts_utc}-{uuid.uuid4().hex[:8]}"

    prepared = []
    total_hours_sum = 0.0
    for it in items:
        w1 = float(it.week1_hours or 0)
        w2 = float(it.week2_hours or 0)
        hrs = w1 + w2
        rate = float(it.labor_rate or 0)
        total = rate * hrs
        total_hours_sum += hrs
        prepared.append((
            it.employee_id, it.name, it.reference, it.company, it.location, it.position,
            rate, w1, w2, hrs, total
        ))

    ben = (comm or {}).get("beneficiary", "danny")
    per_hr = float((comm or {}).get("per_hour_rate", 0.50))
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

@app.get("/payroll/summary/hours_by_company")
def hours_by_company(date_from: Optional[str] = None, date_to: Optional[str] = None):
    con = connect()
    try:
        q = """
        select pr.company as company,
               date(pr.run_ts_utc) as run_date,
               sum(pi.total_hours) as total_hours
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        params: List[Any] = []
        if date_from:
            q += " and pr.run_ts_utc >= ?"; params.append(date_from)
        if date_to:
            q += " and pr.run_ts_utc <= ?"; params.append(date_to)
        q += " group by pr.company, date(pr.run_ts_utc) order by run_date desc, company"
        rows = [dict(r) for r in connect().execute(q, params)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/hours_by_employee")
def hours_by_employee(date_from: Optional[str] = None, date_to: Optional[str] = None, company: Optional[str] = None):
    con = connect()
    try:
        q = """
        select pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc) as run_date,
               sum(pi.total_hours) as total_hours
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        params: List[Any] = []
        if date_from:
            q += " and pr.run_ts_utc >= ?"; params.append(date_from)
        if date_to:
            q += " and pr.run_ts_utc <= ?"; params.append(date_to)
        if company:
            q += " and pr.company = ?"; params.append(company)
        q += " group by pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc)"
        q += " order by run_date desc, company, pi.name"
        rows = [dict(r) for r in connect().execute(q, params)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/payout_by_company")
def payout_by_company(date_from: Optional[str] = None, date_to: Optional[str] = None):
    con = connect()
    try:
        q = """
        select pr.company, date(pr.run_ts_utc) as run_date,
               sum(pi.check_total) as total_payout
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        params: List[Any] = []
        if date_from:
            q += " and pr.run_ts_utc >= ?"; params.append(date_from)
        if date_to:
            q += " and pr.run_ts_utc <= ?"; params.append(date_to)
        q += " group by pr.company, date(pr.run_ts_utc) order by run_date desc, company"
        rows = [dict(r) for r in connect().execute(q, params)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/payout_by_employee")
def payout_by_employee(date_from: Optional[str] = None, date_to: Optional[str] = None, company: Optional[str] = None):
    con = connect()
    try:
        q = """
        select pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc) as run_date,
               sum(pi.check_total) as total_paid
        from payroll_items pi
        join payroll_runs pr on pr.id = pi.run_id
        where 1=1
        """
        params: List[Any] = []
        if date_from:
            q += " and pr.run_ts_utc >= ?"; params.append(date_from)
        if date_to:
            q += " and pr.run_ts_utc <= ?"; params.append(date_to)
        if company:
            q += " and pr.company = ?"; params.append(company)
        q += " group by pi.employee_id, pi.name, pr.company, date(pr.run_ts_utc)"
        q += " order by run_date desc, company, pi.name"
        rows = [dict(r) for r in connect().execute(q, params)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/payroll/summary/commissions")
def commissions_summary(date_from: Optional[str] = None, date_to: Optional[str] = None, beneficiary: Optional[str] = None):
    con = connect()
    try:
        q = """
        select c.beneficiary, date(pr.run_ts_utc) as run_date,
               c.per_hour_rate, c.source_hours, c.total_commission
        from commissions c
        join payroll_runs pr on pr.id = c.run_id
        where 1=1
        """
        params: List[Any] = []
        if date_from:
            q += " and pr.run_ts_utc >= ?"; params.append(date_from)
        if date_to:
            q += " and pr.run_ts_utc <= ?"; params.append(date_to)
        if beneficiary:
            q += " and c.beneficiary = ?"; params.append(beneficiary)
        q += " order by run_date desc"
        rows = [dict(r) for r in connect().execute(q, params)]
        return {"rows": rows}
    finally:
        con.close()

# =========================
# R2 / Documents
# =========================
_s3_client = None

def s3():
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
            config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "virtual"}),
        )
    return _s3_client

def _slug(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "file"

def _ext_from_filename(name: str) -> str:
    base, ext = os.path.splitext(name or "")
    ext = (ext or "").lstrip(".").lower()
    return ext or "bin"

@app.get("/documents/list")
def documents_list(prefix: str = "", limit: int = 500):
    """
    List objects in the bucket (prefix optional).
    """
    try:
        cli = s3()
        paginator = cli.get_paginator("list_objects_v2")
        kwargs = {"Bucket": S3_BUCKET, "Prefix": prefix, "MaxKeys": min(max(1, limit), 1000)}
        rows: List[Dict[str, Any]] = []
        for page in paginator.paginate(**kwargs):
            for item in page.get("Contents", []):
                key = item.get("Key")
                size = item.get("Size")
                lm = item.get("LastModified")
                rows.append({
                    "key": key,
                    "size": size,
                    "last_modified": lm.isoformat() if hasattr(lm, "isoformat") else str(lm),
                    "type": mimetypes.guess_type(key or "")[0] or "application/octet-stream",
                })
        rows.sort(key=lambda r: r["key"])
        return {"rows": rows, "page": 1, "page_size": limit, "total": len(rows)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R2 list error: {e!s}")

# ---- Aliases to satisfy your front-end calls ----
@app.get("/documents")
def documents_alias(limit: int = 500):
    return documents_list(limit=limit)

@app.get("/documents/sync")
def documents_sync_alias():
    return documents_list()

@app.post("/documents/upload")
async def documents_upload(
    file: UploadFile = File(...),
    employee_name: str = Form(""),
    document_types: Optional[str] = Form(None),  # comma-separated from the UI
):
    """
    Upload a file to R2 using a normalized key:
    {employeeSlug}/{UTCts}_{typesSlug}.{ext}
    """
    try:
        cli = s3()
        emp = _slug(employee_name or "")
        types_slug = _slug((document_types or "").replace(",", " ").replace(";", " "))
        ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        ext = _ext_from_filename(file.filename)
        key = f"{emp}/{ts}"
        if types_slug:
            key += f"_{types_slug}"
        key += f".{ext}"

        body = await file.read()
        content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"

        cli.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType=content_type,
        )
        return {"ok": True, "key": key, "size": len(body)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R2 upload error: {e!s}")

@app.delete("/documents/delete/{key:path}")
def documents_delete(key: str):
    try:
        cli = s3()
        cli.delete_object(Bucket=S3_BUCKET, Key=key)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R2 delete error: {e!s}")

# =========================
# Health / debug
# =========================
@app.get("/debug/health")
def debug_health():
    # DB touch
    try:
        con = connect(); con.execute("select 1"); con.close()
        db_ok = True
    except Exception:
        db_ok = False
    # S3 config-only check
    r2_ok = bool(S3_ENDPOINT and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET)
    return {"ok": True, "db": db_ok, "r2_configured": r2_ok}

@app.get("/")
def root():
    # No homepage (prevents Render’s health check from 404ing if it probes “/”)
    return {"ok": True}

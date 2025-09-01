# api/app/main.py
import os
import uuid
import datetime
import pathlib
from typing import Any, Dict, List, Optional, Literal

import sqlite3
from fastapi import FastAPI, Body, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

# ----------------- Config -----------------

BASE_DIR = pathlib.Path(__file__).resolve().parent

DB_PATH = os.environ.get("DB_PATH", "employees_with_company_v2.db")
if not os.path.isabs(DB_PATH):
    DB_PATH = str(BASE_DIR / DB_PATH)

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "").strip()
S3_BUCKET = os.environ.get("S3_BUCKET", "").strip()
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "").strip()

print(f"[startup] DB_PATH={DB_PATH}")
if S3_ENDPOINT and S3_BUCKET:
    print(f"[startup] S3_ENDPOINT='{S3_ENDPOINT}'  S3_BUCKET='{S3_BUCKET}'")

# ----------------- App --------------------

app = FastAPI(title="YHO API")

ALLOWED_ORIGINS = [
    "https://yho-stack-1.onrender.com",  # your Next.js app
    "https://yho-stack.onrender.com",    # (optional) if anything makes same-origin calls
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    # Also allow future / preview URLs like yho-stack-1-xxxxx.onrender.com if you ever use them:
    allow_origin_regex=r"https://yho-stack(-\w+)?\.onrender\.com$",
    allow_credentials=False,          # keep False unless you truly need cookies/Authorization as credentials
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],             # not required, but fine
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

# ----------------- Payroll schema ensure -------------

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

# ----------------- Employees (existing) -----------------

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
        keys, vals, qmarks = [], [], []
        for k, v in payload.items():
            keys.append(k); vals.append(v); qmarks.append("?")
        sql = f"insert into employees ({', '.join(keys)}) values ({', '.join(qmarks)})"
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

# ----------------- Payroll: create run (append-only) -----------------
class PayrollItem(BaseModel):
    employee_id: str
    name: Optional[str] = None
    reference: Optional[str] = None
    company: Optional[str] = None
    location: Optional[str] = None
    position: Optional[str] = None
    labor_rate: float = 0
    week1_hours: float = 0
    week2_hours: float = 0

class PayrollCreate(BaseModel):
    scope: Literal["all", "by"] = "all"
    company: Optional[str] = None
    location: Optional[str] = None
    note: Optional[str] = None
    items: List[PayrollItem] = []
    commission: Optional[Dict[str, Any]] = None

@app.post("/payroll/runs")
def create_payroll_run(payload: PayrollCreate):
    scope = payload.scope
    company = payload.company
    location = payload.location
    note = payload.note
    items = payload.items
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
            it.employee_id, it.name, it.reference, it.company, it.location,
            it.position, rate, w1, w2, hrs, total
        ))

    ben = (comm.get("beneficiary") or "danny").lower()
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

# ----------------- Summaries -----------------
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

# ----------------- R2 / S3 client -----------------

def _s3():
    if not (S3_ENDPOINT and S3_BUCKET and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY):
        raise HTTPException(status_code=500, detail="R2/S3 not configured")
    session = boto3.session.Session()
    client = session.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        config=BotoConfig(
            s3={"addressing_style": "virtual"},
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "standard"},
        ),
        region_name="auto",
        verify=True,
    )
    return client

# ----------------- Documents API -----------------

class DocRow(BaseModel):
    key: str
    size: int
    modified: Optional[str] = None
    url: Optional[str] = None

@app.get("/documents")
def list_documents(
    limit: int = Query(50, ge=1, le=1000),
    prefix: str = "",
):
    """
    List rows from R2 (no DB state yet).
    """
    client = _s3()
    try:
        resp = client.list_objects_v2(Bucket=S3_BUCKET, Prefix=prefix, MaxKeys=limit)
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"R2 list error: {e}")

    rows: List[DocRow] = []
    for obj in resp.get("Contents", []):
        rows.append(DocRow(
            key=obj["Key"],
            size=int(obj.get("Size", 0)),
            modified=obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
            url=None,  # private bucket; we’re not exposing presigned URLs here
        ))
    return {"rows": [r.dict() for r in rows], "page": 1, "page_size": limit, "total": len(rows)}

@app.post("/documents/sync")
def sync_documents():
    """
    Placeholder for future DB syncing; for now just proves we can touch the bucket.
    """
    client = _s3()
    try:
        client.head_bucket(Bucket=S3_BUCKET)
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"R2 head error: {e}")
    return {"ok": True}

@app.post("/documents/upload")
def upload_document(
    employee: str = Form(""),
    types: Optional[str] = Form(None),  # comma-separated from checkboxes
    file: UploadFile = File(...),
):
    """
    Upload a single file into the bucket. Object key pattern:
      <employee>__<types>__<uuid>__<original-name>
    """
    client = _s3()

    clean_emp = (employee or "").strip().replace(" ", "")
    clean_types = (types or "").strip().replace(" ", "")
    key = f"{clean_emp or 'unknown'}__{clean_types or 'doc'}__{uuid.uuid4().hex}__{file.filename}"

    try:
        client.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=file.file,
            ContentType=file.content_type or "application/octet-stream",
        )
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"R2 upload error: {e}")

    return {"ok": True, "key": key}

# ----------------- Health -----------------

@app.get("/debug/health")
def health():
    ok_db = True
    try:
        con = connect(); con.execute("select 1"); con.close()
    except Exception:
        ok_db = False
    return {"ok": True, "db": ok_db}



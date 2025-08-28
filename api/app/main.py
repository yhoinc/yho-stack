# api/app/main.py
import os
import uuid
import pathlib
import datetime
from typing import Any, Dict, List, Optional

import sqlite3
from fastapi import FastAPI, Body, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware

import boto3
from botocore.client import Config
import certifi

# ----------------- Config -----------------
BASE_DIR = pathlib.Path(__file__).resolve().parent
DB_PATH = os.environ.get("DB_PATH", "employees_with_company_v2.db")
DATA_DIR = os.environ.get("DATA_DIR", "/data")

# Resolve DB path relative to this file if not absolute
if not os.path.isabs(DB_PATH):
    DB_PATH = str((BASE_DIR / DB_PATH).resolve())

# ---- Cloudflare R2 / S3-style settings (MUST be set in your API service env) ----
S3_ENDPOINT = (os.environ.get("S3_ENDPOINT", "") or "").rstrip("/")
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "")
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "")

# Build an S3 client compatible with Cloudflare R2 and a known-good CA bundle
def build_s3_client():
    if not (S3_ENDPOINT and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET):
        # We'll lazily raise on use to let the rest of the API function
        return None
    return boto3.client(
        "s3",
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        endpoint_url=S3_ENDPOINT,        # e.g. https://<accountid>.r2.cloudflarestorage.com
        region_name="auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        verify=certifi.where(),          # <-- important: fix SSL handshake failures
    )

s3 = build_s3_client()

print(f"[startup] Using DB: {DB_PATH}")

# ----------------- App --------------------
app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],             # tighten for prod
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

# ----------------- Schema Ensure (Optional) -------------
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
    # Seed local /data DB if needed
    os.makedirs(DATA_DIR, exist_ok=True)
    con = connect()
    try:
        con.executescript(PAYROLL_SCHEMA)
        con.commit()
    finally:
        con.close()

# ----------------- Health -----------------
@app.get("/debug/health")
def health():
    # Check DB
    try:
        con = connect()
        with con:
            con.execute("select 1")
        db_ok = True
    except Exception:
        db_ok = False
    # S3 presence is optional; report availability
    s3_ok = bool(s3 is not None)
    return {"ok": True, "db": db_ok, "s3": s3_ok}

# ----------------- Employees -----------------
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
        keys = []
        vals = []
        qmarks = []
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
        sets = []
        vals = []
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
@app.post("/payroll/runs")
def create_payroll_run(payload: Dict[str, Any] = Body(...)):
    """
    payload = {
      "scope": "all" | "by",
      "company": null | "SHINBO",
      "location": null | "TEXAS",
      "note": "optional",
      "items": [
        { "employee_id": "...", "name": "...", "reference": "...",
          "company": "...", "location": "...", "position": "...",
          "labor_rate": 25, "week1_hours": 40, "week2_hours": 38 },
        ...
      ],
      "commission": { "beneficiary": "danny", "per_hour_rate": 0.50 }
    }
    """
    scope = payload.get("scope") or "all"
    company = payload.get("company")
    location = payload.get("location")
    note = payload.get("note")
    items = payload.get("items") or []
    comm = payload.get("commission") or {"beneficiary": "danny", "per_hour_rate": 0.50}

    # build totals
    run_ts_utc = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()
    run_key = f"{run_ts_utc}-{uuid.uuid4().hex[:8]}"

    prepared = []
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

# ----------------- Documents (Cloudflare R2) -----------------
def _require_s3():
    if s3 is None:
        raise HTTPException(status_code=500, detail="R2/S3 is not configured")

def _obj_to_dict(obj: dict) -> dict:
    return {
        "key": obj.get("Key"),
        "size": obj.get("Size", 0),
        "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
        "etag": obj.get("ETag"),
        "storage_class": obj.get("StorageClass"),
    }

@app.get("/documents/list")
def documents_list(
    q: str = Query("", description="Optional prefix filter"),
    max_keys: int = Query(100, ge=1, le=1000),
    continuation_token: Optional[str] = None,
):
    _require_s3()
    try:
        params = {"Bucket": S3_BUCKET, "MaxKeys": max_keys}
        if q:
            params["Prefix"] = q
        if continuation_token:
            params["ContinuationToken"] = continuation_token
        resp = s3.list_objects_v2(**params)
        contents = [_obj_to_dict(o) for o in resp.get("Contents", [])]
        return {
            "rows": contents,
            "is_truncated": resp.get("IsTruncated", False),
            "next_continuation_token": resp.get("NextContinuationToken"),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R2 list error: {e}")

@app.post("/documents/presign")
def documents_presign_put(
    key: str = Body(..., embed=True),
    expires_seconds: int = Body(900, embed=True),   # 15 minutes
    content_type: Optional[str] = Body(None, embed=True),
):
    _require_s3()
    try:
        params = {"Bucket": S3_BUCKET, "Key": key}
        if content_type:
            params["ContentType"] = content_type
        url = s3.generate_presigned_url(
            "put_object",
            Params=params,
            ExpiresIn=expires_seconds,
        )
        return {"url": url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R2 presign error: {e}")

@app.post("/documents/upload")
async def documents_upload(
    file: UploadFile = File(...),
    employee: str = Form(""),
    doctype: str = Form(""),   # e.g. tax, id, directdeposit or any string
):
    """
    Server-side upload to R2. Useful when you don't want the browser to PUT directly.
    """
    _require_s3()
    try:
        safe_emp = employee.strip().replace(" ", "_") or "unknown"
        safe_doc = doctype.strip().replace(" ", "_") or "file"
        ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        base_name = file.filename or "upload.bin"
        key = f"{safe_emp}/{safe_doc}_{ts}_{base_name}"

        body = await file.read()
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType=file.content_type or "application/octet-stream",
        )
        return {"ok": True, "key": key}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R2 upload error: {e}")

@app.post("/documents/delete")
def documents_delete(key: str = Body(..., embed=True)):
    _require_s3()
    try:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R2 delete error: {e}")

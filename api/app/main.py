import os
import re
import uuid
import datetime
import pathlib
import shutil
import sqlite3
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Body, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# ----------------- Config -----------------

BASE_DIR = pathlib.Path(__file__).resolve().parent

# Prefer DATA_DIR if present (Render disk), else local dir.
DATA_DIR = os.environ.get("DATA_DIR")
if DATA_DIR:
    pathlib.Path(DATA_DIR).mkdir(parents=True, exist_ok=True)

DB_PATH = os.environ.get("DB_PATH")
if not DB_PATH:
    db_name = "employees_with_company_v2.db"
    DB_PATH = str(pathlib.Path(DATA_DIR or BASE_DIR) / db_name)

print(f"[startup] Using DB: {DB_PATH}")

# Cloudflare R2 (S3 compatible) env
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
R2_BUCKET = os.environ.get("R2_BUCKET")

# build endpoint if creds provided
R2_ENDPOINT = (
    f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com" if R2_ACCOUNT_ID else None
)

# ----------------- App --------------------

app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- Health / root ----
@app.get("/", tags=["meta"])
def root():
    return {"status": "ok"}

@app.get("/debug/health", tags=["meta"])
def debug_health():
    return {"ok": True}

# ----------------- DB helpers -------------

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def execmany(con: sqlite3.Connection, sql: str, rows: List[tuple]):
    cur = con.cursor()
    cur.executemany(sql, rows)
    cur.close()

# ----------------- Schema Ensure -------------

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

/* Documents storage metadata */
create table if not exists documents (
  id             integer primary key autoincrement,
  object_key     text not null unique,
  employee_id    text,
  employee_name  text not null,
  doc_types      text,                 -- comma-separated: tax,id,deposit
  content_type   text,
  size           integer,
  uploaded_at    text not null
);
create index if not exists idx_documents_emp on documents(employee_name);
create index if not exists idx_documents_empid on documents(employee_id);
"""

@app.on_event("startup")
def ensure_schema():
    # If a db file exists next to app and data dir is empty path, copy once.
    try:
        if DATA_DIR:
            target = pathlib.Path(DB_PATH)
            if not target.exists():
                # prefer v2 then v1 next to app
                for name in ("employees_with_company_v2.db", "employees_with_company.db"):
                    src = BASE_DIR / name
                    if src.exists():
                        shutil.copy2(src, target)
                        print(f"[startup] Seeded DB to volume: {target}")
                        break
    except Exception as e:
        print(f"[startup] Seed copy skipped: {e}")

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
        rows = [
            dict(r)
            for r in con.execute(
                "select * from employees order by name limit ? offset ?",
                (limit, offset),
            )
        ]
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

    ben = (comm.get("beneficiary") or "danny").strip()
    per_hr = float(comm.get("per_hour_rate") or 0.50)
    commission_total = per_hr * total_hours_sum

    con = connect()
    try:
        cur = con.cursor()
        cur.execute(
            "insert into payroll_runs (run_key, run_ts_utc, scope, company, location, note) values (?,?,?,?,?,?)",
            (run_key, run_ts_utc, scope, company, location, note),
        )
        run_id = cur.lastrowid

        execmany(
            con,
            """insert into payroll_items
               (run_id, employee_id, name, reference, company, location, position,
                labor_rate, week1_hours, week2_hours, total_hours, check_total)
               values (?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(run_id,) + row for row in prepared],
        )

        cur.execute(
            "insert into commissions (run_id, beneficiary, per_hour_rate, source_hours, total_commission) values (?,?,?,?,?)",
            (run_id, ben, per_hr, total_hours_sum, commission_total),
        )

        con.commit()
        return {
            "run_id": run_id,
            "run_key": run_key,
            "commission": {
                "beneficiary": ben,
                "per_hour_rate": per_hr,
                "source_hours": total_hours_sum,
                "total_commission": commission_total,
            },
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
        rows = [dict(r) for r in con.execute(q, params)]
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
        rows = [dict(r) for r in con.execute(q, params)]
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
        rows = [dict(r) for r in con.execute(q, params)]
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
        rows = [dict(r) for r in con.execute(q, params)]
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
        rows = [dict(r) for r in con.execute(q, params)]
        return {"rows": rows}
    finally:
        con.close()

# ----------------- Documents (R2) -----------------

def _require_r2():
    if not all([R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET]):
        raise HTTPException(
            status_code=500,
            detail="R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.",
        )

# Lazy import boto3 to keep startup fast
def _boto3():
    import boto3  # type: ignore
    return boto3

_slug_re = re.compile(r"[^a-z0-9]+")
def _slug(s: str) -> str:
    s = s.strip().lower()
    s = _slug_re.sub("-", s)
    return s.strip("-") or "x"

@app.post("/documents/presign-upload")
def presign_upload(payload: Dict[str, Any] = Body(...)):
    """
    Request body:
      employee_name (str, required)
      employee_id (str | null)
      doc_types (list[str]) e.g. ["tax","id"]
      filename (str)
      content_type (str)
    """
    _require_r2()
    employee_name = (payload.get("employee_name") or "").strip()
    if not employee_name:
        raise HTTPException(400, "employee_name required")

    employee_id = payload.get("employee_id")
    doc_types = payload.get("doc_types") or []
    filename = payload.get("filename") or "file"
    content_type = payload.get("content_type") or "application/octet-stream"

    # Build a readable, unique key
    today = datetime.datetime.utcnow().strftime("%Y/%m/%d")
    prefix = f"employees/{today}"
    name_slug = _slug(employee_name)
    id_slug = _slug(employee_id) if employee_id else "na"
    types_slug = "-".join(_slug(t) for t in doc_types) or "doc"
    ext = pathlib.Path(filename).suffix or ""
    key = f"{prefix}/{name_slug}-{id_slug}-{types_slug}-{uuid.uuid4().hex[:8]}{ext}"

    b3 = _boto3()
    s3 = b3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )

    put_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": R2_BUCKET,
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=900,  # 15 minutes
    )

    # Some UAs require explicit content-type header to match
    return {"key": key, "upload_url": put_url, "headers": {"Content-Type": content_type}}

@app.post("/documents/save")
def save_document(payload: Dict[str, Any] = Body(...)):
    """
    After uploading to R2 with the presigned URL, call this to write the DB row.
    Required: key, employee_name
    Optional: employee_id, doc_types(list[str] or comma str), size, content_type
    """
    key = payload.get("key")
    employee_name = (payload.get("employee_name") or "").strip()
    if not key or not employee_name:
        raise HTTPException(400, "key and employee_name required")

    employee_id = payload.get("employee_id")
    doc_types = payload.get("doc_types") or []
    if isinstance(doc_types, list):
        doc_types = ",".join([str(x).strip() for x in doc_types if str(x).strip()])

    size = payload.get("size")
    content_type = payload.get("content_type")

    uploaded_at = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()

    con = connect()
    try:
        cur = con.cursor()
        cur.execute(
            """insert into documents (object_key, employee_id, employee_name, doc_types, content_type, size, uploaded_at)
               values (?, ?, ?, ?, ?, ?, ?)""",
            (key, employee_id, employee_name, doc_types, content_type, size, uploaded_at),
        )
        con.commit()
        return {"id": cur.lastrowid, "key": key}
    finally:
        con.close()

@app.get("/documents/search")
def search_documents(
    q: Optional[str] = Query(None, description="search employee_name, employee_id, doc_types"),
    limit: int = 50,
    offset: int = 0,
):
    con = connect()
    try:
        base = "select * from documents"
        params: List[Any] = []
        if q:
            base += " where (employee_name like ? or ifnull(employee_id,'') like ? or ifnull(doc_types,'') like ?)"
            like = f"%{q}%"
            params.extend([like, like, like])
        base += " order by uploaded_at desc limit ? offset ?"
        params.extend([limit, offset])
        rows = [dict(r) for r in con.execute(base, params)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/documents/{doc_id}/download")
def presign_download(doc_id: int):
    _require_r2()

    con = connect()
    try:
        row = con.execute("select object_key from documents where id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        key = row["object_key"]
    finally:
        con.close()

    b3 = _boto3()
    s3 = b3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": R2_BUCKET, "Key": key},
        ExpiresIn=900,
    )
    return {"url": url}

@app.delete("/documents/{doc_id}")
def delete_document(doc_id: int):
    _require_r2()

    # fetch the key first
    con = connect()
    try:
        row = con.execute("select object_key from documents where id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        key = row["object_key"]
    finally:
        con.close()

    # delete from bucket
    b3 = _boto3()
    s3 = b3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )
    try:
        s3.delete_object(Bucket=R2_BUCKET, Key=key)
    except Exception as e:
        # not fatal—proceed to delete row; but log to stdout
        print(f"[documents] delete_object warning: {e}")

    # delete DB row
    con = connect()
    try:
        con.execute("delete from documents where id = ?", (doc_id,))
        con.commit()
        return {"ok": True}
    finally:
        con.close()

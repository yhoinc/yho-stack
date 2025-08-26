import os
import sqlite3
import uuid
import datetime
import pathlib
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Body, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# --- R2 (Cloudflare S3 API) ---
import boto3
from botocore.client import Config
from urllib.parse import quote_plus

# ----------------- Config -----------------
BASE_DIR = pathlib.Path(__file__).resolve().parent
DB_PATH = os.environ.get("DB_PATH", "employees_with_company_v2.db")

# Make relative paths resolve next to main.py
if not os.path.isabs(DB_PATH):
    DB_PATH = str(BASE_DIR / DB_PATH)

DATA_DIR = os.environ.get("DATA_DIR", str(BASE_DIR))
os.makedirs(DATA_DIR, exist_ok=True)

print(f"[startup] Using DB: {DB_PATH}")

# ----------------- App --------------------
app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in prod (e.g., your Render frontend origin)
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
"""

# Documents table (for R2 files)
DOCS_SCHEMA = """
create table if not exists documents (
  id            integer primary key autoincrement,
  employee_id   text,
  employee_name text,
  doc_types     text,              -- comma separated tags (e.g., "tax,id")
  object_key    text not null,     -- R2 object key
  content_type  text,
  size          integer,
  uploaded_at   text not null,
  uploader_ref  text               -- optional (who uploaded)
);
create index if not exists idx_docs_key on documents(object_key);
create index if not exists idx_docs_name on documents(employee_name);
create index if not exists idx_docs_types on documents(doc_types);
"""

@app.on_event("startup")
def ensure_schema():
    con = connect()
    try:
        con.executescript(PAYROLL_SCHEMA)
        con.executescript(DOCS_SCHEMA)
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

# ----------------- R2 client + helpers -----------------
def r2_client():
    """
    Cloudflare R2 S3-compatible client using env vars:
      - R2_BUCKET_ENDPOINT
      - R2_ACCESS_KEY_ID
      - R2_SECRET_ACCESS_KEY
    """
    endpoint = os.environ["R2_BUCKET_ENDPOINT"]
    access_key = os.environ["R2_ACCESS_KEY_ID"]
    secret_key = os.environ["R2_SECRET_ACCESS_KEY"]
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
    )

def safe_key_segment(s: str) -> str:
    # minimal cleaner for employee names / tags -> path-safe
    return "-".join("".join(ch for ch in (s or "").strip() if ch.isalnum() or ch in (" ", "_", "-")).split())

@app.get("/r2/ping")
def r2_ping():
    bucket = os.environ["R2_BUCKET"]
    s3 = r2_client()
    try:
        s3.head_bucket(Bucket=bucket)
        return {"ok": True, "bucket": bucket}
    except Exception as e:
        return {"ok": False, "bucket": bucket, "error": str(e)}

# ----------------- Documents: Upload (pre-signed), Save, Search, Download, Delete -----------------
@app.post("/documents/presign-upload")
def presign_upload(
    employee_name: str = Body(..., embed=True),
    employee_id: Optional[str] = Body(None, embed=True),
    doc_types: Optional[List[str]] = Body(default=None, embed=True),  # e.g. ["tax","id"]
    filename: str = Body(..., embed=True),
    content_type: Optional[str] = Body(None, embed=True),
):
    """
    Returns a pre-signed PUT URL so the client can upload directly to R2.
    After a successful upload, call /documents/save to record metadata.
    """
    bucket = os.environ["R2_BUCKET"]
    s3 = r2_client()

    ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    name_seg = safe_key_segment(employee_name) or "unknown"
    types_seg = safe_key_segment("-".join(doc_types or [])) if doc_types else "doc"
    orig_seg = safe_key_segment(filename)
    key = f"employees/{name_seg}/{ts}_{types_seg}_{orig_seg}"

    # Pre-sign PUT (client will send the file bytes directly)
    params = {
        "Bucket": bucket,
        "Key": key,
    }
    if content_type:
        params["ContentType"] = content_type

    url = s3.generate_presigned_url(
        "put_object",
        Params=params,
        ExpiresIn=60 * 10,  # 10 minutes
        HttpMethod="PUT",
    )

    return {
        "key": key,
        "upload_url": url,
        "headers": {"Content-Type": content_type} if content_type else {},
    }

@app.post("/documents/save")
def save_document_record(payload: Dict[str, Any] = Body(...)):
    """
    Client calls this after a successful pre-signed upload.
    payload = {
      "key": "...",                 (required)
      "employee_name": "...",       (required)
      "employee_id": "...",         (optional)
      "doc_types": ["tax","id"],    (optional)
      "size": 12345,                (optional)
      "content_type": "application/pdf" (optional)
    }
    """
    key = payload.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="key is required")

    employee_name = payload.get("employee_name") or ""
    employee_id = payload.get("employee_id")
    doc_types = payload.get("doc_types") or []
    doc_types_csv = ",".join([t.strip() for t in doc_types if t and isinstance(t, str)])
    size = int(payload.get("size") or 0)
    content_type = payload.get("content_type")

    uploaded_at = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()

    con = connect()
    try:
        cur = con.cursor()
        cur.execute(
            """insert into documents (employee_id, employee_name, doc_types, object_key, content_type, size, uploaded_at)
               values (?,?,?,?,?,?,?)""",
            (employee_id, employee_name, doc_types_csv, key, content_type, size, uploaded_at),
        )
        doc_id = cur.lastrowid
        con.commit()
        return {"ok": True, "id": doc_id}
    finally:
        con.close()

@app.get("/documents/search")
def search_documents(
    q: Optional[str] = Query(None, description="free text in name/types/key"),
    employee: Optional[str] = Query(None, description="exact employee_name filter"),
    limit: int = 50,
    offset: int = 0,
):
    """
    Basic search across employee_name, doc_types, object_key.
    """
    clauses = []
    params: List[Any] = []
    if q:
        like = f"%{q}%"
        clauses.append("(employee_name like ? or doc_types like ? or object_key like ?)")
        params.extend([like, like, like])
    if employee:
        clauses.append("employee_name = ?")
        params.append(employee)

    where = "where " + " and ".join(clauses) if clauses else ""
    sql = f"""
      select id, employee_id, employee_name, doc_types, object_key, content_type, size, uploaded_at
      from documents
      {where}
      order by uploaded_at desc
      limit ? offset ?
    """
    params.extend([limit, offset])

    con = connect()
    try:
        rows = [dict(r) for r in con.execute(sql, params)]
        return {"rows": rows}
    finally:
        con.close()

@app.get("/documents/{doc_id}/download")
def document_download(doc_id: int):
    """
    Returns a pre-signed GET URL to download/view the file.
    """
    con = connect()
    try:
        row = con.execute("select object_key, content_type from documents where id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")
        key = row["object_key"]
        ctype = row["content_type"]
    finally:
        con.close()

    bucket = os.environ["R2_BUCKET"]
    s3 = r2_client()

    params = {"Bucket": bucket, "Key": key}
    if ctype:
        params["ResponseContentType"] = ctype

    url = s3.generate_presigned_url(
        "get_object",
        Params=params,
        ExpiresIn=60 * 10,  # 10 minutes
        HttpMethod="GET",
    )
    return {"url": url}

@app.delete("/documents/{doc_id}")
def delete_document(doc_id: int):
    """
    Deletes the record and the object in R2.
    """
    # first load key
    con = connect()
    try:
        row = con.execute("select object_key from documents where id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")
        key = row["object_key"]
    finally:
        con.close()

    # delete from R2
    bucket = os.environ["R2_BUCKET"]
    s3 = r2_client()
    try:
        s3.delete_object(Bucket=bucket, Key=key)
    except Exception as e:
        # don't fail hard; still attempt to remove record
        print("[warn] r2 delete_object failed:", e)

    # delete record
    con = connect()
    try:
        con.execute("delete from documents where id = ?", (doc_id,))
        con.commit()
        return {"ok": True}
    finally:
        con.close()

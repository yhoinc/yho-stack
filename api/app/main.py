# main.py
import os
import io
import re
import uuid
import json
import pathlib
import sqlite3
import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, Body, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# --- S3 / R2 ---
import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

# ----------------- Config -----------------
BASE_DIR = pathlib.Path(__file__).resolve().parent

DB_PATH = os.environ.get("DB_PATH", "employees_with_company_v2.db")
if not os.path.isabs(DB_PATH):
    DB_PATH = str(BASE_DIR / DB_PATH)

S3_ENDPOINT = (os.environ.get("S3_ENDPOINT") or "").rstrip("/")
S3_BUCKET = os.environ.get("S3_BUCKET") or ""
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID") or ""
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY") or ""
S3_REGION = os.environ.get("S3_REGION") or "auto"

print(f"[startup] DB_PATH={DB_PATH}")
print(f"[startup] S3_ENDPOINT={S3_ENDPOINT!r}  S3_BUCKET={S3_BUCKET!r}")

# ----------------- App --------------------
app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://yho-stack-1.onrender.com",  # frontend
        "https://yho-stack.onrender.com",    # backend itself
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------- DB helpers -------------
def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def execmany(con: sqlite3.Connection, sql: str, rows: List[tuple]):
    cur = con.cursor()
    cur.executemany(sql, rows)
    cur.close()

# ----------------- Schema Ensure ----------
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

DOCUMENTS_SCHEMA = """
create table if not exists documents (
  id               integer primary key autoincrement,
  object_key       text not null unique,
  file_name        text not null,
  employee         text,
  doc_types        text,
  size_bytes       integer,
  etag             text,
  last_modified_utc text,
  uploaded_utc     text
);
create index if not exists idx_documents_emp on documents(employee);
create index if not exists idx_documents_name on documents(file_name);
"""

@app.on_event("startup")
def ensure_schema():
    con = connect()
    try:
        con.executescript(PAYROLL_SCHEMA)
        con.executescript(DOCUMENTS_SCHEMA)
        con.commit()
    finally:
        con.close()

# ----------------- S3 client (R2) ---------
_s3_client = None

def s3():
    """
    Cloudflare R2 requires path-style addressing for TLS to succeed.
    We also normalize the endpoint to avoid trailing slashes or accidental bucket suffixes.
    """
    global _s3_client
    if _s3_client is None:
        if not (S3_ENDPOINT and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET):
            raise HTTPException(status_code=500, detail="R2/S3 not configured")

        endpoint = S3_ENDPOINT.rstrip("/")
        # If user accidentally placed the bucket into the endpoint, remove it.
        if endpoint.endswith(f"/{S3_BUCKET}"):
            endpoint = endpoint[: -(len(S3_BUCKET) + 1)]

        _s3_client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=S3_ACCESS_KEY_ID,
            aws_secret_access_key=S3_SECRET_ACCESS_KEY,
            region_name=S3_REGION,
            config=BotoConfig(
                signature_version="s3v4",
                s3={"addressing_style": "path"},  # << important for R2 TLS
            ),
        )
    return _s3_client

# ----------------- Utilities --------------
SAFE_CHARS = re.compile(r"[^A-Za-z0-9_.-]+")

def slugify(s: str) -> str:
    s = (s or "").strip()
    s = SAFE_CHARS.sub("-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "file"

def utcnow_iso() -> str:
    return datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc).isoformat()

# ----------------- Health -----------------
@app.get("/debug/health")
def debug_health():
    ok = True
    db_ok = False
    r2_ok = False
    # DB
    try:
        con = connect()
        try:
            con.execute("select 1")
            db_ok = True
        finally:
            con.close()
    except Exception:
        ok = False
    # R2
    try:
        s3().list_buckets()  # cheap call on R2
        r2_ok = True
    except Exception:
        ok = False
    return {"ok": ok, "db": db_ok, "r2": r2_ok}

# ----------------- Employees --------------
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

# ----------------- Payroll ----------------
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

    run_ts_utc = utcnow_iso()
    run_key = f"{run_ts_utc}-{uuid.uuid4().hex[:8]}"

    prepared: List[Tuple] = []
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

# ----------------- Documents (R2) --------
def upsert_document(con: sqlite3.Connection, row: Dict[str, Any]):
    cur = con.cursor()
    cur.execute(
        """
        insert into documents (object_key, file_name, employee, doc_types,
                               size_bytes, etag, last_modified_utc, uploaded_utc)
        values (?,?,?,?,?,?,?,?)
        on conflict(object_key) do update set
           file_name=excluded.file_name,
           employee=excluded.employee,
           doc_types=excluded.doc_types,
           size_bytes=excluded.size_bytes,
           etag=excluded.etag,
           last_modified_utc=excluded.last_modified_utc
        """,
        (
            row.get("object_key"),
            row.get("file_name"),
            row.get("employee"),
            row.get("doc_types"),
            row.get("size_bytes"),
            row.get("etag"),
            row.get("last_modified_utc"),
            row.get("uploaded_utc"),
        ),
    )

@app.get("/documents")
def documents_list(
    q: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    page: int = Query(1, ge=1),
):
    offset = (page - 1) * limit
    con = connect()
    try:
        base = "from documents where 1=1"
        params: List[Any] = []
        if q:
            base += " and (file_name like ? or employee like ? or doc_types like ?)"
            t = f"%{q}%"
            params.extend([t, t, t])

        total = con.execute(f"select count(*) {base}", params).fetchone()[0]
        rows = [dict(r) for r in con.execute(
            f"select * {base} order by last_modified_utc desc, file_name limit ? offset ?",
            params + [limit, offset]
        )]
        return {"rows": rows, "page": page, "page_size": limit, "total": total}
    finally:
        con.close()

@app.post("/documents/sync")
def documents_sync():
    """
    Pull the object list from R2 and mirror into the 'documents' table.
    """
    client = s3()
    con = connect()
    try:
        # list in pages
        token = None
        seen = 0
        while True:
            kw = dict(Bucket=S3_BUCKET, MaxKeys=1000)
            if token:
                kw["ContinuationToken"] = token
            resp = client.list_objects_v2(**kw)
            contents = resp.get("Contents", []) or []
            for obj in contents:
                key = obj.get("Key")
                size = obj.get("Size")
                etag = (obj.get("ETag") or "").strip('"')
                lm = obj.get("LastModified")
                lm_iso = lm.astimezone(datetime.timezone.utc).isoformat() if lm else None
                file_name = key.split("/")[-1]
                # try to parse hints from name: e.g. "Jane-Doe__Identification__...__file.pdf"
                employee = None
                doc_types = None
                parts = file_name.split("__")
                if len(parts) >= 3:
                    employee = parts[0].replace("-", " ")
                    doc_types = parts[1].replace("-", " ")

                upsert_document(con, {
                    "object_key": key,
                    "file_name": file_name,
                    "employee": employee,
                    "doc_types": doc_types,
                    "size_bytes": size,
                    "etag": etag,
                    "last_modified_utc": lm_iso,
                    "uploaded_utc": None,
                })
                seen += 1

            if resp.get("IsTruncated"):
                token = resp.get("NextContinuationToken")
            else:
                break

        con.commit()
        return {"ok": True, "synced": seen}
    except ClientError as e:
        detail = getattr(e, "response", {}).get("Error", {}).get("Message") or str(e)
        raise HTTPException(status_code=500, detail=f"R2 list error: {detail}")
    finally:
        con.close()

@app.post("/documents/upload")
async def documents_upload(
    employee_name: str = Form(""),
    doc_types: str = Form(""),
    file: UploadFile = File(...),
):
    """
    Upload a document to R2 and record it in the DB.

    Frontend typically joins selected types with commas (e.g., "Tax Form,Identification")
    """
    client = s3()
    emp_slug = slugify(employee_name)
    types_slug = slugify(doc_types.replace(",", "-"))
    ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    base_name = slugify(pathlib.Path(file.filename).name)
    key = f"{emp_slug}__{types_slug}__{ts}__{base_name}".strip("_")

    buf = await file.read()
    fobj = io.BytesIO(buf)

    try:
        client.upload_fileobj(
            fobj,
            S3_BUCKET,
            key,
            ExtraArgs={"ContentType": file.content_type or "application/octet-stream"},
        )
    except ClientError as e:
        detail = getattr(e, "response", {}).get("Error", {}).get("Message") or str(e)
        raise HTTPException(status_code=500, detail=f"R2 upload error: {detail}")

    # Head the object for metadata
    try:
        head = client.head_object(Bucket=S3_BUCKET, Key=key)
        size = head.get("ContentLength")
        etag = (head.get("ETag") or "").strip('"')
        lm = head.get("LastModified")
        lm_iso = lm.astimezone(datetime.timezone.utc).isoformat() if lm else None
    except Exception:
        size, etag, lm_iso = len(buf), None, None

    con = connect()
    try:
        upsert_document(con, {
            "object_key": key,
            "file_name": pathlib.Path(file.filename).name,
            "employee": employee_name.strip() or None,
            "doc_types": doc_types.strip() or None,
            "size_bytes": size,
            "etag": etag,
            "last_modified_utc": lm_iso,
            "uploaded_utc": utcnow_iso(),
        })
        con.commit()
        return {"ok": True, "key": key, "size": size}
    finally:
        con.close()

@app.get("/documents/download")
def documents_download(key: str):
    """
    Stream a document from R2 to the client (inline).
    """
    client = s3()
    try:
        obj = client.get_object(Bucket=S3_BUCKET, Key=key)
    except ClientError as e:
        status = getattr(e, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode", 404)
        raise HTTPException(status_code=status, detail="Not Found")

    content_type = obj.get("ContentType") or "application/octet-stream"
    body = obj["Body"]

    return StreamingResponse(body, media_type=content_type)

# --------------- Root (optional) ----------
@app.get("/")
def root():
    return {"ok": True}


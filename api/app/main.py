import os
import io
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# ----- Optional S3 (R2 / Backblaze / Supabase-compatible) -----
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

# ----- Excel parsing -----
import pandas as pd

# =============================================================================
# Config
# =============================================================================
DATA_DIR = os.getenv("DATA_DIR", "/data")
os.makedirs(DATA_DIR, exist_ok=True)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "employees_with_company_v4.db")

# S3-compatible object storage (optional)
S3_ENDPOINT = (os.getenv("S3_ENDPOINT") or "").strip()
S3_REGION = os.getenv("S3_REGION", "us-east-1")
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID")
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY")
S3_BUCKET = os.getenv("S3_BUCKET")

def _normalize_endpoint(ep: str) -> str:
    ep = ep.strip()
    if ep.startswith("https://"):
        ep = ep[len("https://"):]
    if ep.startswith("http://"):
        ep = ep[len("http://"):]
    return ep

S3_HOST = _normalize_endpoint(S3_ENDPOINT) if S3_ENDPOINT else ""


# =============================================================================
# App
# =============================================================================
app = FastAPI(title="YHO API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,
)


# =============================================================================
# DB helpers
# =============================================================================
def open_db() -> sqlite3.Connection:
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"DB not found at {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn

def ensure_schema(conn: sqlite3.Connection) -> None:
    # Runs header
    conn.execute("""
    CREATE TABLE IF NOT EXISTS payroll_runs (
        run_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        run_key      TEXT UNIQUE,
        created_at   TEXT DEFAULT (datetime('now')),
        scope        TEXT,
        company      TEXT,
        location     TEXT,
        note         TEXT
    );
    """)
    # Items (one per employee in the run)
    conn.execute("""
    CREATE TABLE IF NOT_EXISTS payroll_items (
        item_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       INTEGER NOT NULL,
        employee_id  TEXT,
        name         TEXT,
        timesheet_name TEXT,
        reference    TEXT,
        company      TEXT,
        location     TEXT,
        position     TEXT,
        labor_rate   REAL,
        per_diem     REAL,
        week1_hours  REAL,
        week2_hours  REAL,
        days         REAL,
        wages_total  REAL,   -- labor_rate * (w1 + w2)
        perdiem_total REAL,  -- per_diem * days
        total_out    REAL,   -- wages_total + perdiem_total
        FOREIGN KEY(run_id) REFERENCES payroll_runs(run_id)
    );
    """.replace("NOT_EXISTS","NOT EXISTS"))
    # Commissions (per run)
    conn.execute("""
    CREATE TABLE IF NOT EXISTS payroll_commissions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        INTEGER NOT NULL,
        beneficiary   TEXT,   -- e.g. 'danny'
        per_hour_rate REAL,   -- 0.50
        source_hours  REAL,   -- sum of hours from items
        total_commission REAL,
        FOREIGN KEY(run_id) REFERENCES payroll_runs(run_id)
    );
    """)

def list_tables(conn: sqlite3.Connection) -> List[str]:
    t = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return [r["name"] for r in t]

def dict_from_row(r: sqlite3.Row) -> Dict[str, Any]:
    return {k: r[k] for k in r.keys()}

def first_table_with_column(conn: sqlite3.Connection, colname: str) -> Optional[Tuple[str, List[str]]]:
    for t in list_tables(conn):
        cols = [c["name"] for c in conn.execute(f"PRAGMA table_info('{t}')").fetchall()]
        if colname in cols:
            return t, cols
    return None

def discover_employee_table(conn: sqlite3.Connection) -> Tuple[str, List[str]]:
    tables = list_tables(conn)
    if not tables:
        raise RuntimeError("No tables found in SQLite DB.")

    for t in tables:
        if t.lower() == "employees":
            cols = [c["name"] for c in conn.execute(f"PRAGMA table_info('{t}')").fetchall()]
            return t, cols

    found = first_table_with_column(conn, "employee_id")
    if found:
        return found

    tname = tables[0]
    cols = [c["name"] for c in conn.execute(f"PRAGMA table_info('{tname}')").fetchall()]
    return tname, cols

def to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return float(value)
        s = str(value).strip()
        if not s:
            return None
        s = s.replace("$", "").replace(",", "")
        return float(s)
    except Exception:
        return None

def compute_labor_rate_display(row: Dict[str, Any]) -> Optional[float]:
    for key in ("labor_rate", "pay_rate", "payrate", "rate", "hourly_rate"):
        if key in row:
            n = to_float(row.get(key))
            if n is not None:
                return n
    return None

def filter_payload_to_table(payload: Dict[str, Any], columns: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in payload.items():
        if k in columns:
            if k in ("labor_rate", "per_diem", "pay_rate", "payrate", "hourly_rate"):
                out[k] = to_float(v)
            else:
                out[k] = v
    return out


# =============================================================================
# Employees
# =============================================================================
@app.get("/employees")
def list_employees(limit: int = Query(1000, ge=1, le=10000), offset: int = Query(0, ge=0)):
    try:
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)
            total = conn.execute(f"SELECT COUNT(*) AS c FROM '{tname}'").fetchone()["c"]
            rs = conn.execute(f"SELECT * FROM '{tname}' LIMIT ? OFFSET ?", (limit, offset)).fetchall()
            rows = [dict_from_row(r) for r in rs]
            for row in rows:
                row["labor_rate_display"] = compute_labor_rate_display(row)
            return {"rows": rows, "total": total, "limit": limit, "offset": offset, "table": tname, "columns": cols}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/employees/{employee_id}")
def get_employee(employee_id: str):
    try:
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)
            r = conn.execute(f"SELECT * FROM '{tname}' WHERE employee_id = ?", (employee_id,)).fetchone()
            if not r:
                raise HTTPException(status_code=404, detail="Not found")
            row = dict_from_row(r)
            row["labor_rate_display"] = compute_labor_rate_display(row)
            return row
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/employees")
def create_employee(payload: Dict[str, Any]):
    if not payload or not payload.get("employee_id"):
        raise HTTPException(status_code=400, detail="employee_id is required")
    try:
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)
            data = filter_payload_to_table(payload, cols)
            if not data:
                raise HTTPException(status_code=400, detail="No valid fields to insert")
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
def patch_employee(employee_id: str, payload: Dict[str, Any]):
    if not payload:
        return {"ok": True, "updated": 0}
    try:
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)
            data = filter_payload_to_table(payload, cols)
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


# =============================================================================
# Payroll runs (persist for reports)
# =============================================================================
def _new_run_key(conn: sqlite3.Connection) -> str:
    # cheap unique key: RUNyyyymmddHHMMSS_rowid
    rowid = conn.execute("SELECT IFNULL(MAX(run_id),0)+1 AS n FROM payroll_runs").fetchone()["n"]
    key = conn.execute("SELECT strftime('%Y%m%d%H%M%S','now')").fetchone()[0]
    return f"RUN{key}_{rowid}"

@app.post("/payroll/runs")
def save_payroll_run(payload: Dict[str, Any]):
    """
    payload: {
      scope, company, location, note,
      items: [{employee_id,name,reference,company,location,position,labor_rate,per_diem,week1_hours,week2_hours,days}],
      commission: { beneficiary: "danny", per_hour_rate: 0.50 }
    }
    """
    try:
        with open_db() as conn:
            cur = conn.cursor()
            run_key = _new_run_key(conn)
            cur.execute(
                "INSERT INTO payroll_runs(run_key,scope,company,location,note) VALUES(?,?,?,?,?)",
                (run_key, payload.get("scope"), payload.get("company"), payload.get("location"), payload.get("note")),
            )
            run_id = cur.lastrowid

            items = payload.get("items") or []
            total_hours = 0.0
            for it in items:
                lr = to_float(it.get("labor_rate")) or 0.0
                pd = to_float(it.get("per_diem")) or 0.0
                w1 = to_float(it.get("week1_hours")) or 0.0
                w2 = to_float(it.get("week2_hours")) or 0.0
                days = to_float(it.get("days")) or 0.0
                hours = (w1 + w2)
                wages_total = lr * hours
                perdiem_total = pd * days
                total_out = wages_total + perdiem_total
                total_hours += hours

                cur.execute("""
                INSERT INTO payroll_items(
                    run_id, employee_id, name, timesheet_name, reference, company, location, position,
                    labor_rate, per_diem, week1_hours, week2_hours, days,
                    wages_total, perdiem_total, total_out
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    run_id,
                    it.get("employee_id"), it.get("name"), it.get("timesheet_name"),
                    it.get("reference"), it.get("company"), it.get("location"), it.get("position"),
                    lr, pd, w1, w2, days, wages_total, perdiem_total, total_out
                ))

            # Commission: fixed rule 0.50 per hour for "danny"
            c = payload.get("commission") or {}
            rate = to_float(c.get("per_hour_rate")) or 0.50
            beneficiary = (c.get("beneficiary") or "danny").strip().lower()  # store lowercased
            total_commission = rate * total_hours
            cur.execute("""
                INSERT INTO payroll_commissions(run_id, beneficiary, per_hour_rate, source_hours, total_commission)
                VALUES(?,?,?,?,?)
            """, (run_id, beneficiary, rate, total_hours, total_commission))

            conn.commit()
            return {
                "ok": True,
                "run_id": run_id,
                "run_key": run_key,
                "commission": {
                    "beneficiary": beneficiary,
                    "per_hour_rate": rate,
                    "source_hours": total_hours,
                    "total_commission": total_commission,
                },
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Reports
# =============================================================================
@app.get("/reports/runs")
def list_runs(limit: int = 50):
    with open_db() as conn:
        rs = conn.execute("""
            SELECT r.run_id, r.run_key, r.created_at, r.scope, r.company, r.location,
                   c.total_commission, c.source_hours, c.per_hour_rate
            FROM payroll_runs r
            LEFT JOIN payroll_commissions c ON c.run_id = r.run_id
            ORDER BY r.run_id DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return {"rows": [dict_from_row(r) for r in rs]}

@app.get("/reports/summary")
def summary(
    date_from: Optional[str] = None,  # "YYYY-MM-DD"
    date_to: Optional[str] = None     # "YYYY-MM-DD"
):
    """
    Aggregates across saved runs. If dates are provided, filter by created_at (inclusive).
    Returns:
      { by_company: [...], by_employee: [...] }
    """
    with open_db() as conn:
        where = []
        params: List[Any] = []
        if date_from:
            where.append("date(r.created_at) >= date(?)")
            params.append(date_from)
        if date_to:
            where.append("date(r.created_at) <= date(?)")
            params.append(date_to)
        W = "WHERE " + " AND ".join(where) if where else ""

        by_company = conn.execute(f"""
            SELECT
                COALESCE(i.company,'(none)') AS company,
                ROUND(SUM(i.week1_hours + i.week2_hours), 2)     AS hours,
                ROUND(SUM(i.wages_total), 2)                     AS wages,
                ROUND(SUM(i.perdiem_total), 2)                   AS per_diem,
                ROUND(SUM(i.total_out), 2)                       AS grand_total
            FROM payroll_items i
            JOIN payroll_runs r ON r.run_id = i.run_id
            {W}
            GROUP BY COALESCE(i.company,'(none)')
            ORDER BY company
        """, params).fetchall()

        by_employee = conn.execute(f"""
            SELECT
                i.employee_id,
                i.name,
                COALESCE(i.company,'(none)') AS company,
                COALESCE(i.location,'')      AS location,
                ROUND(SUM(i.week1_hours + i.week2_hours), 2)     AS hours,
                ROUND(SUM(i.wages_total), 2)                     AS wages,
                ROUND(SUM(i.perdiem_total), 2)                   AS per_diem,
                ROUND(SUM(i.total_out), 2)                       AS grand_total
            FROM payroll_items i
            JOIN payroll_runs r ON r.run_id = i.run_id
            {W}
            GROUP BY i.employee_id, i.name, i.company, i.location
            ORDER BY i.name
        """, params).fetchall()

        # Commission total for 'danny'
        commission = conn.execute(f"""
            SELECT
                ROUND(SUM(c.total_commission), 2) AS total_commission,
                ROUND(SUM(c.source_hours), 2)     AS hours,
                MAX(c.per_hour_rate)              AS per_hour_rate
            FROM payroll_commissions c
            JOIN payroll_runs r ON r.run_id = c.run_id
            {W}
            AND LOWER(c.beneficiary) = 'danny'
        """.replace("WHERE AND", "WHERE"), params).fetchone()

        return {
            "by_company": [dict_from_row(r) for r in by_company],
            "by_employee": [dict_from_row(r) for r in by_employee],
            "commission": dict_from_row(commission) if commission else None,
        }


# =============================================================================
# Timesheet parse (keeps your “Employee”/“Total Hours” row logic)
# =============================================================================
def _extract_pairs_from_excel(df: pd.DataFrame) -> List[Tuple[str, float]]:
    """
    Walk rows; when a cell contains 'Employee' on that row, capture the other
    non-empty cell as the name. The subsequent row that contains 'Total Hours'
    will have the hours value in the other non-empty cell.
    Returns list of (name, hours).
    """
    pairs: List[Tuple[str, float]] = []
    name: Optional[str] = None

    def row_texts(series: pd.Series) -> List[str]:
        vals = []
        for v in series.tolist():
            if pd.isna(v):
                continue
            s = str(v).strip()
            if s:
                vals.append(s)
        return vals

    for _, row in df.iterrows():
        texts = row_texts(row)
        if not texts:
            continue
        joined = " | ".join(texts).lower()

        if "employee" in joined and name is None:
            # The name is the other non-empty cell on the same row
            if len(texts) >= 2:
                # pick the cell that isn't the word Employee
                options = [t for t in texts if "employee" not in t.lower()]
                if options:
                    name = options[0]
            continue

        if "total hours" in joined and name is not None:
            # hours is the numeric on this row that isn't the literal label
            hours_val: Optional[float] = None
            for t in texts:
                if t.lower().find("total hours") >= 0:
                    continue
                try:
                    hours_val = float(str(t).replace(",", ""))
                    break
                except Exception:
                    pass
            if hours_val is not None:
                pairs.append((name, hours_val))
            name = None

    return pairs

@app.post("/timesheet/parse")
async def parse_timesheet(file: UploadFile = File(...)):
    try:
        content = await file.read()
        # openpyxl for xlsx/xlsm; xlrd handles xls (installed in requirements)
        try:
            df = pd.read_excel(io.BytesIO(content), engine="openpyxl", header=None)
        except Exception:
            # retry as old xls
            df = pd.read_excel(io.BytesIO(content), engine="xlrd", header=None)
        pairs = _extract_pairs_from_excel(df)

        # Map to employees by timesheet_name (case-insensitive, strip trailing "(123)")
        with open_db() as conn:
            tname, cols = discover_employee_table(conn)
            ts_col = "timesheet_name" if "timesheet_name" in cols else "name"
            rs = conn.execute(f"SELECT employee_id, {ts_col} AS tname FROM '{tname}'").fetchall()
            book = []
            for r in rs:
                t = (r["tname"] or "").strip()
                if t:
                    book.append((r["employee_id"], t.lower()))

        matched = []
        unmatched = []
        for raw_name, hours in pairs:
            n = (raw_name or "").strip()
            core = n
            # drop trailing "(123)" if present
            if core.endswith(")") and "(" in core:
                core = core[:core.rfind("(")].strip()
            key = core.lower()
            found_id = None
            for eid, tname_lc in book:
                if tname_lc == key:
                    found_id = eid
                    break
            if found_id:
                matched.append({"employee_id": found_id, "name": core, "hours": hours})
            else:
                unmatched.append({"name": n, "reason": "No exact timesheet_name match", "hours": hours})

        return {"matched": matched, "unmatched": unmatched}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# =============================================================================
# Documents (S3-compatible)
# =============================================================================
def s3_client():
    if not (S3_HOST and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET):
        raise RuntimeError("S3 not fully configured; set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET.")
    return boto3.client(
        "s3",
        region_name=S3_REGION,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        endpoint_url=f"https://{S3_HOST}",
        config=Config(s3={"addressing_style": "path"}),
    )

@app.get("/documents")
def list_documents(limit: int = 500):
    try:
        s3 = s3_client()
        paginator = s3.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=S3_BUCKET, PaginationConfig={"MaxItems": limit})
        rows: List[Dict[str, Any]] = []
        for page in pages:
            for obj in page.get("Contents", []) or []:
                rows.append({
                    "key": obj["Key"],
                    "size": obj.get("Size", 0),
                    "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
                })
                if len(rows) >= limit:
                    break
            if len(rows) >= limit:
                break
        return {"rows": rows, "total": len(rows)}
    except RuntimeError as e:
        return {"rows": [], "total": 0, "note": str(e)}
    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/documents/upload")
async def upload_document(
    employee_name: str = Form(""),
    doc_types: str = Form(""),
    custom_type: str = Form(""),
    file: UploadFile = File(...),
):
    try:
        s3 = s3_client()
        name_key = "_".join((employee_name or "unknown").split()) or "unknown"
        folder = (custom_type or doc_types or "misc").strip() or "misc"
        filename = file.filename or "upload.bin"
        key = f"{name_key}/{folder}/{filename}"
        body = await file.read()
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType=file.content_type or "application/octet-stream",
        )
        return {"ok": True, "key": key}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except ClientError as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/documents/{key:path}/download")
def download_document(key: str):
    try:
        s3 = s3_client()
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        content_type = obj.get("ContentType") or "application/octet-stream"
        data = obj["Body"].read()
        return StreamingResponse(
            io.BytesIO(data),
            media_type=content_type,
            headers={"Content-Disposition": f'inline; filename="{os.path.basename(key)}"'},
        )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except ClientError as e:
        code = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 500)
        raise HTTPException(status_code=code, detail=str(e))


# =============================================================================
# Debug / Health
# =============================================================================
@app.get("/debug/health")
def health():
    s3_ok = bool(S3_HOST and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET)
    return {
        "ok": True,
        "db_path": DB_PATH,
        "db_exists": os.path.exists(DB_PATH),
        "s3_configured": s3_ok,
        "bucket": S3_BUCKET if s3_ok else None,
    }

@app.get("/debug/db")
def debug_db():
    with open_db() as conn:
        info: Dict[str, Any] = {"tables": [], "meta": []}
        tables = list_tables(conn)
        info["tables"] = tables
        for t in tables:
            cols = [c["name"] for c in conn.execute(f"PRAGMA table_info('{t}')").fetchall()]
            sample = conn.execute(f"SELECT * FROM '{t}' LIMIT 1").fetchone()
            sample_dict = dict_from_row(sample) if sample else None
            info["meta"].append({"table": t, "columns": cols, "sample": sample_dict})
        return info

@app.get("/debug/sample")
def debug_sample(limit: int = 3):
    with open_db() as conn:
        tables = list_tables(conn)
        if not tables:
            return {"tables": [], "rows": []}
        tname = next((t for t in tables if t.lower() == "employees"), tables[0])
        rs = conn.execute(f"SELECT * FROM '{tname}' LIMIT ?", (limit,)).fetchall()
        rows = [dict_from_row(r) for r in rs]
        for row in rows:
            row["labor_rate_display"] = compute_labor_rate_display(row)
        return {"table": tname, "rows": rows}

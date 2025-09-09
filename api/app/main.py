import os
import io
import re
import csv
import sqlite3
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# ----- Optional S3 (R2 / Backblaze / Supabase-compatible) -----
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

# Optional XLS/XLSX support (CSV works without these)
try:
    import pandas as pd  # type: ignore
except Exception:
    pd = None


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
    return conn

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
    """
    Prefer a table literally named 'employees', else any table with 'employee_id' column,
    else the first table found.
    """
    tables = list_tables(conn)
    if not tables:
        raise RuntimeError("No tables found in SQLite DB.")

    # Prefer exact 'employees'
    for t in tables:
        if t.lower() == "employees":
            cols = [c["name"] for c in conn.execute(f"PRAGMA table_info('{t}')").fetchall()]
            return t, cols

    # Else table with employee_id
    found = first_table_with_column(conn, "employee_id")
    if found:
        return found

    # Else first table
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
# Startup: ensure timesheet_name column exists (safe if already present)
# =============================================================================
def ensure_timesheet_name_column() -> None:
    with open_db() as conn:
        tname, _cols = discover_employee_table(conn)
        existing = [c["name"] for c in conn.execute(f"PRAGMA table_info('{tname}')").fetchall()]
        if "timesheet_name" not in existing:
            conn.execute(f"ALTER TABLE '{tname}' ADD COLUMN timesheet_name TEXT")
            # initialize to name for immediate matches
            if "name" in existing:
                conn.execute(f"UPDATE '{tname}' SET timesheet_name = COALESCE(timesheet_name, name) "
                             f"WHERE timesheet_name IS NULL OR timesheet_name = ''")
            conn.commit()

@app.on_event("startup")
def on_startup():
    ensure_timesheet_name_column()


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
# Timesheet upload/preview (auto-fill payroll)
# =============================================================================

# Normalize: lowercase, strip accents, collapse spaces, trim
def _norm(s: Optional[str]) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s

# Strip trailing " (12345)" (and any extra space before it)
_PAREN_NUMBER_RE = re.compile(r"\s*\(\s*\d+\s*\)\s*$")

def _strip_paren_number_suffix(s: str) -> str:
    return _PAREN_NUMBER_RE.sub("", s or "")

def _coerce_num(v: Any) -> float:
    if v is None or v == "":
        return 0.0
    try:
        s = str(v).strip().replace(",", "")
        return float(s)
    except Exception:
        return 0.0

# Column alias detection (case-insensitive)
def _find_key(d: Dict[str, Any], candidates: List[str]) -> Optional[str]:
    low = {k.lower(): k for k in d.keys()}
    for c in candidates:
        if c in low:
            return low[c]
    return None

@app.post("/payroll/timesheet/preview")
async def timesheet_preview(file: UploadFile = File(...)):
    """
    Upload a customer timesheet (CSV or XLS/XLSX if pandas is available).
    Extract rows -> (name, week1_hours, week2_hours [optional]).
    We strip trailing ' (12345)' from names before matching.

    Returns:
      {
        "ok": true,
        "matched": [{ employee_id, name, timesheet_name, week1_hours, week2_hours }],
        "unmatched": [{ raw_name, week1_hours, week2_hours, reason }]
      }
    """
    content = await file.read()
    filename = (file.filename or "").lower()
    rows: List[Dict[str, Any]] = []

    # Parse file
    if filename.endswith(".csv"):
        try:
            text = content.decode("utf-8", errors="ignore")
            reader = csv.DictReader(io.StringIO(text))
            rows = list(reader)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse CSV: {e}")
    elif filename.endswith(".xlsx") or filename.endswith(".xls"):
        if pd is None:
            raise HTTPException(status_code=400, detail="XLS/XLSX requires pandas; please upload CSV or install pandas.")
        try:
            df = pd.read_excel(io.BytesIO(content))
            rows = df.to_dict(orient="records")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse Excel: {e}")
    else:
        raise HTTPException(status_code=400, detail="Unsupported file type. Upload CSV or XLS/XLSX.")

    # Normalize and map columns
    parsed: List[Dict[str, Any]] = []
    for r in rows:
        # Column aliases (case-insensitive)
        name_key = _find_key(r, ["name", "employee", "worker", "full_name", "employee_name"])
        w1_key   = _find_key(r, ["week1", "w1", "week 1", "wk1", "hours", "total", "regular", "reg"])
        w2_key   = _find_key(r, ["week2", "w2", "week 2", "wk2"])

        raw_name = str(r.get(name_key, "")).strip() if name_key else ""
        raw_name = _strip_paren_number_suffix(raw_name)  # remove " (12345)"
        week1 = _coerce_num(r.get(w1_key)) if w1_key else 0.0
        week2 = _coerce_num(r.get(w2_key)) if w2_key else 0.0

        if raw_name:
            parsed.append({"raw_name": raw_name, "week1_hours": week1, "week2_hours": week2})

    # Load employees
    with open_db() as conn:
        tname, _cols = discover_employee_table(conn)
        employees = [dict_from_row(r) for r in conn.execute(f"SELECT * FROM '{tname}'").fetchall()]

    # Build lookups: prefer timesheet_name; fallback to name
    lookup: Dict[str, Dict[str, Any]] = {}
    for e in employees:
        tsn = _norm(_strip_paren_number_suffix(str(e.get("timesheet_name") or "")))
        if tsn:
            lookup[tsn] = e
        nm = _norm(_strip_paren_number_suffix(str(e.get("name") or "")))
        if nm and nm not in lookup:
            lookup[nm] = e

    matched: List[Dict[str, Any]] = []
    unmatched: List[Dict[str, Any]] = []

    # If multiple rows for same person in the sheet, sum them
    accum: Dict[str, Dict[str, Any]] = {}
    for pr in parsed:
        key = _norm(pr["raw_name"])
        if key not in accum:
            accum[key] = {"raw_name": pr["raw_name"], "week1_hours": 0.0, "week2_hours": 0.0}
        accum[key]["week1_hours"] += float(pr["week1_hours"])
        accum[key]["week2_hours"] += float(pr["week2_hours"])

    for key, pr in accum.items():
        emp = lookup.get(key)
        if emp:
            matched.append({
                "employee_id": emp.get("employee_id"),
                "name": emp.get("name"),
                "timesheet_name": emp.get("timesheet_name"),
                "week1_hours": round(pr["week1_hours"], 2),
                "week2_hours": round(pr["week2_hours"], 2),
            })
        else:
            unmatched.append({
                "raw_name": pr["raw_name"],
                "week1_hours": round(pr["week1_hours"], 2),
                "week2_hours": round(pr["week2_hours"], 2),
                "reason": "No matching employee by timesheet_name/name",
            })

    return {
        "ok": True,
        "matched": matched,
        "unmatched": unmatched,
        "note": "Names are normalized and '(12345)' suffixes are ignored for matching.",
    }


# =============================================================================
# Documents (S3-compatible). If not configured, returns empty list for /documents.
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
        # not configured -> don't break the whole app
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

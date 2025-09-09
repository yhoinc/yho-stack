import os
import io
import re
import csv
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# S3 / R2 (unchanged)
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

# NEW: excel/csv parsing
import pandas as pd

# =============================================================================
# Config
# =============================================================================
DATA_DIR = os.getenv("DATA_DIR", "/data")
os.makedirs(DATA_DIR, exist_ok=True)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "employees_with_company_v4.db")

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
    allow_origins=["*"],  # tighten in prod later
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
# Timesheet Parsing (NEW)
# =============================================================================
_name_clean_re = re.compile(r"\s*\([^)]*\)\s*$")  # strip trailing " (123)"

def clean_timesheet_name(name: str) -> str:
    s = _name_clean_re.sub("", name or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s.lower()

def find_total_hours_value(row: List[Any]) -> Optional[float]:
    # Find "Total Hours" (case-insensitive substring). Then the first numeric cell to the right.
    idx = None
    for i, cell in enumerate(row):
        if "total hours" in str(cell).strip().lower():
            idx = i
            break
    if idx is None:
        return None
    for j in range(idx + 1, len(row)):
        n = to_float(row[j])
        if n is not None:
            return n
    return None

def load_grid_from_upload(upload: UploadFile) -> List[List[Any]]:
    content = upload.file.read()
    fname = (upload.filename or "").lower()
    if fname.endswith(".csv"):
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            text = content.decode("latin-1", errors="replace")
        return [row for row in csv.reader(io.StringIO(text))]
    # excel
    with io.BytesIO(content) as bio:
        if fname.endswith(".xls") or fname.endswith(".xlsx"):
            df = pd.read_excel(bio, header=None)
            return df.where(pd.notna(df), None).values.tolist()
    raise HTTPException(status_code=400, detail="Unsupported file type. Use .csv, .xls, or .xlsx")

@app.post("/timesheet/parse")
async def timesheet_parse(file: UploadFile = File(...)):
    """
    Scans the sheet linearly:
      - If a row looks like an employee name, remember it as current_name
      - The next row (or any following row) that contains 'Total Hours' gives the hours
      - Emit pair (current_name -> hours), then clear current_name and continue
    Matching to DB uses employees.timesheet_name (normalized).
    """
    grid = load_grid_from_upload(file)

    # Build lookup: normalized timesheet_name -> employee
    with open_db() as conn:
        tname, cols = discover_employee_table(conn)
        has_timesheet_col = "timesheet_name" in [c.lower() for c in cols]
        if not has_timesheet_col:
            # fall back to name
            rs = conn.execute(f"SELECT employee_id, name FROM '{tname}'").fetchall()
            db_rows = [{"employee_id": r["employee_id"], "timesheet_name": (r["name"] or "")} for r in rs]
        else:
            rs = conn.execute(f"SELECT employee_id, name, timesheet_name FROM '{tname}'").fetchall()
            db_rows = [dict_from_row(r) for r in rs]

    db_map: Dict[str, Dict[str, Any]] = {}
    for r in db_rows:
        key = clean_timesheet_name(str(r.get("timesheet_name") or r.get("name") or ""))
        if key:
            db_map[key] = r

    def looks_like_name(row: List[Any]) -> Optional[str]:
        # heuristic: a single non-empty string cell on the row; not "Total Hours"
        non_empty = [str(c).strip() for c in row if c not in (None, "", "nan")]
        if len(non_empty) != 1:
            return None
        s = non_empty[0]
        if "total hours" in s.lower():
            return None
        # names tend to have a space; but allow single token too
        return s

    pairs: List[Tuple[str, Optional[float]]] = []
    current_name: Optional[str] = None

    for row in grid:
        if current_name is None:
            nm = looks_like_name(row)
            if nm:
                current_name = nm
            continue
        # we have a current name; look for the total row
        hours = find_total_hours_value(row)
        if hours is not None:
            pairs.append((current_name, hours))
            current_name = None

    # If file ended with a dangling name that never got a Total Hours line,
    # we can ignore or emit unmatched with reason.
    unmatched: List[Dict[str, Any]] = []
    matched: List[Dict[str, Any]] = []

    for nm, hrs in pairs:
        key = clean_timesheet_name(nm)
        emp = db_map.get(key)
        if not emp:
            unmatched.append({"name": nm, "reason": "No DB match", "hours": hrs})
        else:
            matched.append({
                "employee_id": emp["employee_id"],
                "name": emp.get("name") or nm,
                "hours": hrs,
            })

    # If we had a name waiting without a total row:
    if current_name:
        unmatched.append({"name": current_name, "reason": "No 'Total Hours' row after name", "hours": None})

    return {"matched": matched, "unmatched": unmatched}
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

import os
import sqlite3
import uuid
import datetime
from typing import Any, Dict, List, Optional
import pathlib
import shutil

from fastapi import FastAPI, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# =========================================================
# Config: DB path resolution (local & Fly volume-friendly)
# =========================================================

BASE_DIR = pathlib.Path(__file__).resolve().parent

# Default DB file name (alongside this file in local dev)
DEFAULT_DB_FILENAME = "employees_with_company_v2.db"

# Allow override via env; if relative, resolve next to main.py
DB_PATH = os.environ.get("DB_PATH", DEFAULT_DB_FILENAME)
if not os.path.isabs(DB_PATH):
    DB_PATH = str(BASE_DIR / DB_PATH)

# Fly volume mount directory (when provided)
DATA_DIR = os.environ.get("DATA_DIR")

# If a DATA_DIR is set (e.g. /data on Fly), seed the DB there once and use it
if DATA_DIR:
    target = pathlib.Path(DATA_DIR) / pathlib.Path(DB_PATH).name
    if not target.exists():
        seed = pathlib.Path(DB_PATH) if os.path.exists(DB_PATH) else (BASE_DIR / DEFAULT_DB_FILENAME)
        if seed.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(seed, target)
            print(f"[startup] Seeded DB to volume: {target}")
    DB_PATH = str(target)

print(f"[startup] Using DB: {DB_PATH}")

# =========================================================
# App & CORS
# =========================================================

app = FastAPI(title="YHO API")

# ALLOWED_ORIGINS can be a comma-separated list, e.g.
# "http://localhost:3000,https://your-web.vercel.app"
allowed_origins_env = os.environ.get("ALLOWED_ORIGINS", "*")
allowed_origins = [o.strip() for o in allowed_origins_env.split(",")] if allowed_origins_env else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================================================
# DB helpers
# =========================================================

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def execmany(con: sqlite3.Connection, sql: str, rows: List[tuple]):
    cur = con.cursor()
    cur.executemany(sql, rows)
    cur.close()

# =========================================================
# Schema ensure (append-only payroll tables)
# =========================================================

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

# =========================================================
# Employees
# =========================================================

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

# =========================================================
# Payroll: create run (append-only)
# =========================================================

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

# =========================================================
# Summaries
# =========================================================

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

# =========================================================
# Debug endpoints (handy during deploy)
# =========================================================

@app.get("/debug/health")
def debug_health():
    return {"status": "ok", "db_path": DB_PATH, "allowed_origins": allowed_origins}

@app.get("/debug/tables")
def debug_tables():
    con = connect()
    try:
        rows = [dict(r) for r in con.execute(
            "select name, sql from sqlite_master where type='table' order by name"
        )]
        return {"tables": rows}
    finally:
        con.close()

@app.get("/debug/employees_count")
def debug_employees_count():
    con = connect()
    try:
        row = con.execute("select count(*) as c from employees").fetchone()
        return {"employees_count": (row["c"] if row else 0)}
    except Exception as e:
        return {"error": str(e)}
    finally:
        con.close()
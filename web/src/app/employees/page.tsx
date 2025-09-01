"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";

/** If set, calls this host. Otherwise uses same origin. */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

/* ============================= Types ============================== */

type NumLike = number | string;
type StrOpt = string | null | undefined;

export interface Employee {
  employee_id: string;
  reference: StrOpt;
  company: StrOpt;
  location: StrOpt;
  name: StrOpt;
  phone: StrOpt;
  address: StrOpt;
  position: StrOpt;
  labor_rate: number | null;
  deduction: StrOpt;
  debt: StrOpt;
  payment_count: StrOpt;
  apartment_id: StrOpt;
  per_diem: number | null;
  // tolerate extra fields without using `any`
  [k: string]: unknown;
}

interface EmployeesEnvelope {
  rows: Employee[];
  total?: number;
}

/* ============================ Helpers ============================= */

function apiUrl(path: string) {
  return API_BASE ? `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}` : path;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const msg = await res.text().catch(() => `${res.status} ${res.statusText}`);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const toText = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v);

function toCurrency(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function normalizeArrayOrEnvelope(input: EmployeesEnvelope | Employee[]): Employee[] {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.rows)) return input.rows;
  return [];
}

/** Build CSV (Excel compatible) */
function makeCSV(rows: Employee[], columns: GridColDef<Employee>[]): string {
  const header = columns.map((c) => c.headerName ?? c.field).join(",");
  const escape = (s: string) =>
    /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

  const lines = rows.map((r) =>
    columns
      .map((c) => {
        const field = c.field as keyof Employee;
        const raw = r[field];
        let text = "";
        if (typeof c.valueGetter === "function") {
          // valueGetter signature: (params) => value
          // We’ll emulate with the row only.
          try {
            // @ts-expect-error valueGetter generic context is fine here
            text = toText(c.valueGetter({ row: r }));
          } catch {
            text = toText(raw);
          }
        } else if (typeof c.valueFormatter === "function") {
          try {
            // @ts-expect-error valueFormatter generic context is fine here
            text = toText(c.valueFormatter({ value: raw, row: r }));
          } catch {
            text = toText(raw);
          }
        } else {
          text = toText(raw);
        }
        return escape(text);
      })
      .join(",")
  );

  return [header, ...lines].join("\n");
}

function download(filename: string, data: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================== Page =============================== */

export default function EmployeesPage() {
  const [rows, setRows] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // search (debounced)
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setDebounced(query), 250);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const url = new URL(apiUrl("/employees"), window.location.href);
      url.searchParams.set("limit", "2000");
      const data = await getJson<EmployeesEnvelope | Employee[]>(url.toString());
      setRows(normalizeArrayOrEnvelope(data));
    } catch (e) {
      setErr((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredRows = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return rows;

    return rows.filter((r) => {
      const bucket = [
        toText(r.employee_id),
        toText(r.reference),
        toText(r.company),
        toText(r.location),
        toText(r.name),
        toText(r.phone),
        toText(r.address),
        toText(r.position),
        toText(r.labor_rate),
        toText(r.deduction),
        toText(r.debt),
        toText(r.payment_count),
        toText(r.apartment_id),
        toText(r.per_diem),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return bucket.includes(q);
    });
  }, [rows, debounced]);

  const columns = useMemo<GridColDef<Employee>[]>(() => {
    const col = (field: keyof Employee, headerName: string, width = 140): GridColDef<Employee> => ({
      field,
      headerName,
      width,
      sortable: true,
    });

    return [
      col("employee_id", "ID", 120),
      col("reference", "Reference", 120),
      col("company", "Company", 140),
      col("location", "Location", 140),
      { field: "name", headerName: "Name", flex: 1, minWidth: 200, sortable: true },
      col("phone", "Phone", 140),
      { field: "address", headerName: "Address", flex: 1.2, minWidth: 220, sortable: true },
      col("position", "Position", 140),
      {
        field: "labor_rate",
        headerName: "Labor Rate",
        width: 130,
        sortable: true,
        valueFormatter: (p) => toCurrency(typeof p.value === "number" ? p.value : Number(p.value)),
      },
      col("deduction", "Deduction", 110),
      col("debt", "Debt", 110),
      col("payment_count", "Payments", 110),
      col("apartment_id", "Apt ID", 110),
      {
        field: "per_diem",
        headerName: "Per Diem",
        width: 120,
        sortable: true,
        valueFormatter: (p) => toCurrency(typeof p.value === "number" ? p.value : Number(p.value)),
      },
    ];
  }, []);

  const exportCSV = useCallback(() => {
    if (filteredRows.length === 0) {
      alert("No rows to export.");
      return;
    }
    const csv = makeCSV(filteredRows, columns);
    download(`employees_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }, [filteredRows, columns]);

  return (
    <Box sx={{ maxWidth: 1200, mx: "auto", p: 2 }}>
      {/* Toolbar */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ mb: 2 }}>
        <Box>
          <Typography component="h1" variant="h5" fontWeight={600}>
            Employees
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Search, sort, and export your full employee database.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            placeholder="Search employees…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            color="primary"
            startIcon={<DownloadIcon />}
            onClick={exportCSV}
          >
            Export CSV
          </Button>
        </Stack>
      </Stack>

      {/* Status */}
      {err ? (
        <Box sx={{ mb: 2, color: "error.main" }}>{err}</Box>
      ) : null}

      {/* Grid */}
      <Box sx={{ height: 720, width: "100%" }}>
        {loading && rows.length === 0 ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
            <CircularProgress />
          </Stack>
        ) : (
          <DataGrid
            rows={filteredRows.map((r, i) => ({ id: `row-${i}-${r.employee_id ?? i}`, ...r }))}
            columns={columns}
            disableRowSelectionOnClick
            pageSizeOptions={[25, 50, 100, 250, 500]}
            initialState={{
              pagination: { paginationModel: { pageSize: 100, page: 0 } },
              sorting: { sortModel: [{ field: "name", sort: "asc" }] },
            }}
            sx={{
              "& .MuiDataGrid-columnHeaders": { backgroundColor: "rgb(248 250 252)" },
            }}
          />
        )}
      </Box>
    </Box>
  );
}

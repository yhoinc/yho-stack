"use client";

import * as React from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { DataGrid, GridColDef, GridToolbar } from "@mui/x-data-grid";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";

// ---------- Types ----------
type Employee = {
  employee_id: string;
  reference?: string | null;
  company?: string | null;
  location?: string | null;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  position?: string | null;

  // canonical numeric fields (may come as string from API -> we coerce)
  labor_rate?: number | string | null;
  per_diem?: number | string | null;

  // legacy/alt fields (API also returns labor_rate_display)
  pay_rate?: number | string | null;
  payrate?: number | string | null;
  rate?: number | string | null;
  hourly_rate?: number | string | null;

  // derived from API (guaranteed by backend)
  labor_rate_display?: number | null;

  deduction?: string | null;
  debt?: string | null;
  payment_count?: string | null;
  apartment_id?: string | null;
};

type ApiEmployeesResponse = {
  rows: Employee[];
  total: number;
  limit: number;
  offset: number;
  table?: string;
  columns?: string[];
};

// ---------- Utils ----------
const coerceNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const moneyFmt = (v: unknown): string => {
  const n = coerceNumber(v);
  return n === null ? "-" : `$${n.toFixed(2)}`;
};

const numFmt = (v: unknown): string => {
  const n = coerceNumber(v);
  return n === null ? "-" : n.toFixed(2);
};

const fileDownload = (filename: string, contents: string, mime = "text/csv;charset=utf-8") => {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// ---------- Page ----------
export default function EmployeesPage(): JSX.Element {
  const API_BASE_RAW = process.env.NEXT_PUBLIC_API_BASE || "";
  const API = API_BASE_RAW.replace(/\/$/, "");

  const [rows, setRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // search
  const [query, setQuery] = React.useState<string>("");
  const [debounced, setDebounced] = React.useState<string>(query);
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(id);
  }, [query]);

  const filteredRows = React.useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return rows;
    const toText = (v: unknown) => (v == null ? "" : String(v));
    return rows.filter((r) => {
      const hay = [
        r.employee_id,
        r.name,
        r.reference,
        r.company,
        r.location,
        r.position,
        r.phone,
        r.address,
        r.apartment_id,
      ]
        .map(toText)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, debounced]);

  // fetch
  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const url = `${API}/employees?limit=2000`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as ApiEmployeesResponse;
      const next = Array.isArray(data?.rows) ? data.rows : [];
      setRows(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Load failed";
      setLoadError(`Could not load employees: ${msg}. Check NEXT_PUBLIC_API_BASE ("${API || "(unset)"}").`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [API]);

  React.useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // dialog state
  const [open, setOpen] = React.useState<boolean>(false);
  const [mode, setMode] = React.useState<"create" | "edit">("create");
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);

  const openCreate = () => {
    setMode("create");
    setForm({
      employee_id: "",
      name: "",
      reference: "",
      company: "",
      location: "",
      position: "",
      phone: "",
      per_diem: "",
      labor_rate: "",
    });
    setError(null);
    setOpen(true);
  };

  const openEdit = (emp: Employee) => {
    setMode("edit");
    setForm({ ...emp });
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      // Always write canonical keys: labor_rate & per_diem
      const lr =
        coerceNumber(form.labor_rate) ??
        coerceNumber(form.pay_rate) ??
        coerceNumber(form.payrate) ??
        coerceNumber(form.rate) ??
        coerceNumber(form.hourly_rate);

      const payload: Record<string, unknown> = {
        ...form,
        labor_rate: lr,
        per_diem: coerceNumber(form.per_diem),
      };

      if (mode === "create") {
        const id = String(payload.employee_id || "").trim();
        const name = String(payload.name || "").trim();
        if (!id || !name) {
          setError("Employee ID and Name are required");
          setSaving(false);
          return;
        }
        const res = await fetch(`${API}/employees`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
      } else {
        const id = String(payload.employee_id || "");
        // Don’t send the key field inside PATCH set
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { employee_id: _omit, labor_rate_display: _omit2, ...rest } = payload;
        const res = await fetch(`${API}/employees/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rest),
        });
        if (!res.ok) throw new Error(await res.text());
      }

      setOpen(false);
      await fetchRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // columns
  const columns: GridColDef<Employee>[] = [
    { field: "employee_id", headerName: "ID", minWidth: 120 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "reference", headerName: "Ref", minWidth: 110 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    { field: "phone", headerName: "Phone", minWidth: 150 },
    {
      field: "per_diem",
      headerName: "Per Diem",
      minWidth: 120,
      type: "number",
      valueFormatter: (p) => numFmt(p.value),
    },
    {
      field: "labor_rate_display",
      headerName: "Labor Rate",
      minWidth: 140,
      type: "number",
      valueFormatter: (p) => moneyFmt(p.value),
      sortComparator: (a, b) => {
        const na = typeof a === "number" ? a : coerceNumber(a) ?? -Infinity;
        const nb = typeof b === "number" ? b : coerceNumber(b) ?? -Infinity;
        return na - nb;
      },
    },
    {
      field: "actions",
      headerName: "Actions",
      sortable: false,
      filterable: false,
      width: 100,
      renderCell: (params) => (
        <IconButton size="small" onClick={() => openEdit(params.row)} aria-label="edit">
          <EditIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  // Export CSV of the filteredRows
  const exportCsv = () => {
    const cols = [
      "employee_id",
      "name",
      "reference",
      "company",
      "location",
      "position",
      "phone",
      "per_diem",
      "labor_rate_display",
    ] as const;

    const header = cols.join(",");
    const lines = filteredRows.map((r) =>
      cols
        .map((c) => {
          const val =
            c === "labor_rate_display" ? coerceNumber(r.labor_rate_display) :
            c === "per_diem" ? coerceNumber(r.per_diem) :
            (r[c] as unknown);

          const s = val == null ? "" : String(val);
          // basic CSV escaping
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    );
    fileDownload("employees_export.csv", [header, ...lines].join("\n"));
  };

  return (
    <Stack gap={2}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        API: <b>{API || "(relative)"}</b> • Loaded: <b>{rows.length}</b> {loadError ? `• ${loadError}` : ""}
      </Typography>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ sm: "center" }}
        justifyContent="space-between"
        gap={1}
      >
        <Typography variant="h5" fontWeight={600}>
          Employees
        </Typography>
        <Stack direction="row" gap={1} alignItems="center" sx={{ width: { xs: "100%", sm: "auto" } }}>
          <TextField
            size="small"
            placeholder="Search name, company, location, position…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ width: { xs: "100%", sm: 360 } }}
          />
          <Button variant="outlined" onClick={exportCsv}>
            Export CSV
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            Add Employee
          </Button>
        </Stack>
      </Stack>

      <Box sx={{ height: 640, width: "100%", bgcolor: "background.paper", borderRadius: 2, p: 1 }}>
        <DataGrid
          rows={filteredRows}
          columns={columns}
          getRowId={(r) => r.employee_id}
          loading={loading}
          disableRowSelectionOnClick
          slots={{ toolbar: GridToolbar }}
          initialState={{
            pagination: { paginationModel: { pageSize: 25, page: 0 } },
            sorting: { sortModel: [{ field: "name", sort: "asc" }] },
          }}
          pageSizeOptions={[10, 25, 50, 100]}
        />
      </Box>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{mode === "create" ? "Add Employee" : "Edit Employee"}</DialogTitle>
        <DialogContent dividers>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
              gap: 2,
              mt: 0,
            }}
          >
            <TextField
              label="Employee ID *"
              value={form.employee_id ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, employee_id: e.target.value }))}
              disabled={mode === "edit"}
            />
            <TextField
              label="Name *"
              value={form.name ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
            <TextField
              label="Reference"
              value={form.reference ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))}
            />
            <TextField
              label="Company"
              value={form.company ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))}
            />
            <TextField
              label="Location"
              value={form.location ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))}
            />
            <TextField
              label="Position"
              value={form.position ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, position: e.target.value }))}
            />
            <TextField
              label="Phone"
              value={form.phone ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
            />
            <TextField
              label="Per Diem"
              type="number"
              value={form.per_diem ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, per_diem: e.target.value }))}
            />
            <TextField
              label="Labor Rate"
              type="number"
              value={
                (form.labor_rate as string | number | undefined) ??
                (form.pay_rate as string | number | undefined) ??
                (form.payrate as string | number | undefined) ??
                (form.rate as string | number | undefined) ??
                (form.hourly_rate as string | number | undefined) ??
                ""
              }
              onChange={(e) => setForm((p) => ({ ...p, labor_rate: e.target.value }))}
            />
          </Box>
          {error && (
            <Typography color="error" variant="body2" sx={{ mt: 2 }}>
              {error}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} variant="contained" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

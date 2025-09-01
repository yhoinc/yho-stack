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

type Employee = {
  employee_id: string;
  reference?: string | null;
  company?: string | null;
  location?: string | null;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  position?: string | null;
  labor_rate?: number | string | null;
  per_diem?: number | string | null;
  deduction?: string | null;
  debt?: string | null;
  payment_count?: string | null;
  apartment_id?: string | null;
};

export default function EmployeesPage() {
  // ——— IMPORTANT: this should be set in Render to https://yho-stack.onrender.com ———
  const ENV_API = process.env.NEXT_PUBLIC_API_BASE || "";
  const API = ENV_API.replace(/\/$/, ""); // trim trailing slash

  const [rows, setRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // search (debounced)
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState(query);
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(id);
  }, [query]);

  const filteredRows = React.useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return rows;
    const toText = (v: unknown) => (v == null ? "" : String(v));
    return rows.filter((r) => {
      const bucket = [
        r.employee_id,
        r.name,
        r.reference,
        r.company,
        r.location,
        r.position,
        r.phone,
        r.address,
        r.labor_rate,
        r.per_diem,
        r.deduction,
        r.debt,
        r.payment_count,
        r.apartment_id,
      ]
        .map(toText)
        .join(" ")
        .toLowerCase();
      return bucket.includes(q);
    });
  }, [rows, debounced]);

  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    // we’ll try absolute first, then relative as a fallback
    const candidates = [
      API ? `${API}/employees?limit=2000` : null,
      "/employees?limit=2000", // relative fallback (works if you are reverse proxying)
    ].filter(Boolean) as string[];

    for (const url of candidates) {
      try {
        console.log("[employees] fetching", url);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const text = await res.text();
          console.warn("[employees] non-OK response", res.status, text);
          throw new Error(`${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        console.log("[employees] payload", data);

        const next: Employee[] = Array.isArray((data as any)?.rows)
          ? (data as any).rows
          : Array.isArray(data)
          ? (data as any)
          : [];

        setRows(next);
        setLoading(false);
        return; // success
      } catch (err) {
        console.error("[employees] fetch failed for", url, err);
        // try the next candidate
      }
    }

    setLoadError(
      `Could not load employees. Check NEXT_PUBLIC_API_BASE (current: "${API || "NOT SET"}") and that /employees is reachable.`
    );
    setRows([]);
    setLoading(false);
  }, [API]);

  React.useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const moneyFmt = (p: { value: unknown }) => {
    const n = Number(p?.value);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : "-";
  };
  const numFmt = (p: { value: unknown }) => {
    const n = Number(p?.value);
    return Number.isFinite(n) ? n.toFixed(2) : "-";
  };

  const columns: GridColDef<Employee>[] = [
    { field: "employee_id", headerName: "ID", minWidth: 120 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "reference", headerName: "Ref", minWidth: 110 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    { field: "phone", headerName: "Phone", minWidth: 150 },
    { field: "per_diem", headerName: "Per Diem", minWidth: 120, type: "number", valueFormatter: numFmt },
    { field: "labor_rate", headerName: "Labor Rate", minWidth: 130, valueFormatter: moneyFmt },
    {
      field: "actions",
      headerName: "Actions",
      sortable: false,
      filterable: false,
      width: 100,
      renderCell: (params) => (
        <IconButton size="small" onClick={() => openEdit(params.row as Employee)} aria-label="edit">
          <EditIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  // dialog
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"create" | "edit">("create");
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function openCreate() {
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
  }

  function openEdit(emp: Employee) {
    setMode("edit");
    setForm({ ...emp });
    setError(null);
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { ...form };
      payload.labor_rate =
        payload.labor_rate === "" || payload.labor_rate == null ? null : Number(payload.labor_rate as any);
      payload.per_diem =
        payload.per_diem === "" || payload.per_diem == null ? null : Number(payload.per_diem as any);

      const base = API || ""; // if API is unset, use relative
      if (mode === "create") {
        if (!payload.employee_id || !payload.name) {
          setError("Employee ID and Name are required");
          setSaving(false);
          return;
        }
        const res = await fetch(`${base}/employees`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
      } else {
        const id = String(payload.employee_id ?? "");
        const { employee_id, ...rest } = payload;
        const res = await fetch(`${base}/employees/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rest),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      setOpen(false);
      await fetchRows();
    } catch (e) {
      setError((e as Error).message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap={2}>
      {/* Helpful banner while we troubleshoot */}
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        API base: <b>{API || "(relative)"}</b> • Loaded: <b>{rows.length}</b> row(s) {loadError ? `• ${loadError}` : ""}
      </Typography>

      {/* Toolbar */}
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="space-between" gap={1}>
        <Typography variant="h5" fontWeight={600}>
          Employees
        </Typography>
        <Stack direction="row" gap={1} alignItems="center">
          <TextField
            size="small"
            placeholder="Search name, company, location, position…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ width: { xs: "100%", sm: 360 } }}
          />
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
            <TextField label="Name *" value={form.name ?? ""} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
            <TextField label="Reference" value={form.reference ?? ""} onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))} />
            <TextField label="Company" value={form.company ?? ""} onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))} />
            <TextField label="Location" value={form.location ?? ""} onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))} />
            <TextField label="Position" value={form.position ?? ""} onChange={(e) => setForm((p) => ({ ...p, position: e.target.value }))} />
            <TextField label="Phone" value={form.phone ?? ""} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} />
            <TextField
              label="Per Diem"
              type="number"
              value={form.per_diem ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, per_diem: e.target.value }))}
            />
            <TextField
              label="Labor Rate"
              type="number"
              value={form.labor_rate ?? ""}
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

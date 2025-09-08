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
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import DownloadIcon from "@mui/icons-material/Download";

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

export default function EmployeesPage(): React.ReactElement {
  const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  const [rows, setRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(false);

  // search
  const [query, setQuery] = React.useState("");

  // dialog / form
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"create" | "edit">("create");
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/employees?limit=2000`);
      const d = await r.json();
      const raw: any[] = d?.rows ?? [];
      setRows(raw);
    } finally {
      setLoading(false);
    }
  }, [API]);

  React.useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // ---------- helpers ----------
  const asNumber = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const money = (v: unknown): string => {
    const n = asNumber(v);
    return n == null ? "-" : `$${n.toFixed(2)}`;
  };

  // generate a compact unique ID on client for new employees
  const makeEmployeeId = () =>
    `E-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

  // search across multiple fields
  const filteredRows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.employee_id,
        r.name,
        r.reference,
        r.company,
        r.location,
        r.position,
        r.phone,
      ]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      return hay.some((s) => s.includes(q));
    });
  }, [rows, query]);

  // ---------- grid ----------
  const columns: GridColDef[] = [
    { field: "employee_id", headerName: "ID", minWidth: 140 },
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
      renderCell: (p) => <span>{money(p?.row?.per_diem)}</span>,
    },
    {
      field: "labor_rate",
      headerName: "Labor Rate",
      minWidth: 130,
      renderCell: (p) => {
        const v = p?.row?.labor_rate ?? (p?.row as any)?.pay_rate ?? null;
        return <span>{money(v)}</span>;
      },
    },
    {
      field: "actions",
      headerName: "Actions",
      sortable: false,
      filterable: false,
      width: 100,
      renderCell: (params) => (
        <IconButton
          size="small"
          onClick={() => openEdit(params.row as Employee)}
          aria-label="edit"
        >
          <EditIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  // ---------- dialog handlers ----------
  function openCreate() {
    setMode("create");
    setForm({
      employee_id: makeEmployeeId(),
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
      const payload: any = { ...form };

      // coerce numerics
      payload.labor_rate =
        payload.labor_rate === "" || payload.labor_rate == null
          ? null
          : Number(payload.labor_rate);
      payload.per_diem =
        payload.per_diem === "" || payload.per_diem == null
          ? null
          : Number(payload.per_diem);

      if (mode === "create") {
        if (!payload.employee_id || !payload.name) {
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

        // optimistic insert
        setRows((prev) => [{ ...payload }, ...prev]);
      } else {
        const id = payload.employee_id;
        const { employee_id, ...rest } = payload;
        const res = await fetch(`${API}/employees/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rest),
        });
        if (!res.ok) throw new Error(await res.text());

        // optimistic update
        setRows((prev) =>
          prev.map((r) => (r.employee_id === id ? { ...r, ...rest } : r)),
        );
      }

      setOpen(false);
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ---------- CSV export (entire DB) ----------
  const downloadCSV = () => {
    // export the full database we have loaded (rows), not only the filtered view
    const csvHeaders = [
      "employee_id",
      "name",
      "reference",
      "company",
      "location",
      "position",
      "phone",
      "per_diem",
      "labor_rate",
      "address",
      "deduction",
      "debt",
      "payment_count",
      "apartment_id",
    ];

    const escape = (v: unknown) => {
      if (v == null) return "";
      const s = String(v);
      // quote if needed
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [
      csvHeaders.join(","), // header
      ...rows.map((r) =>
        csvHeaders
          .map((k) =>
            k === "per_diem" || k === "labor_rate"
              ? escape(asNumber((r as any)[k]) ?? "")
              : escape((r as any)[k]),
          )
          .join(","),
      ),
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "employees_database.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---------- UI ----------
  return (
    <Stack gap={2}>
      {/* Header / Actions */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={600}>
          Employees
        </Typography>
        <Stack direction="row" gap={1}>
          <TextField
            size="small"
            placeholder="Search name, company, location, position, phone, ref, or ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ minWidth: 420 }}
          />
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={downloadCSV}
          >
            Download CSV
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            Add Employee
          </Button>
        </Stack>
      </Stack>

      {/* Grid */}
      <Box
        sx={{
          height: 640,
          width: "100%",
          bgcolor: "background.paper",
          borderRadius: 2,
          p: 1,
        }}
      >
        <DataGrid
          rows={filteredRows}
          columns={columns}
          getRowId={(r) => r.employee_id}
          loading={loading}
          disableRowSelectionOnClick
          initialState={{
            pagination: { paginationModel: { pageSize: 25, page: 0 } },
            sorting: { sortModel: [{ field: "name", sort: "asc" }] },
          }}
          pageSizeOptions={[10, 25, 50, 100]}
        />
      </Box>

      {/* Dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {mode === "create" ? "Add Employee" : "Edit Employee"}
        </DialogTitle>
        <DialogContent dividers>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
              gap: 2,
            }}
          >
            <TextField
              label="Employee ID *"
              value={form.employee_id ?? ""}
              disabled // auto-generated on create; not editable
            />
            <TextField
              label="Name *"
              value={form.name ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
            <TextField
              label="Reference"
              value={form.reference ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, reference: e.target.value }))
              }
            />
            <TextField
              label="Company"
              value={form.company ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))}
            />
            <TextField
              label="Location"
              value={form.location ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, location: e.target.value }))
              }
            />
            <TextField
              label="Position"
              value={form.position ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, position: e.target.value }))
              }
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
              onChange={(e) =>
                setForm((p) => ({ ...p, per_diem: e.target.value }))
              }
            />
            <TextField
              label="Labor Rate"
              type="number"
              value={form.labor_rate ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, labor_rate: e.target.value }))
              }
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

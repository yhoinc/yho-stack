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
  const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  const [rows, setRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"create" | "edit">("create");
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/employees?limit=1000`);
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

  const moneyFmt = (n: number | string | null | undefined) => {
    const v = Number(n);
    return Number.isFinite(v) ? `$${v.toFixed(2)}` : "-";
  };
  const numFmt = (n: number | string | null | undefined) => {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(2) : "-";
  };

  const columns: GridColDef[] = [
    { field: "employee_id", headerName: "ID", minWidth: 120 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "reference", headerName: "Ref", minWidth: 110 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    { field: "phone", headerName: "Phone", minWidth: 150 },
    // Per Diem shown as currency; robust to string/number/null
    {
      field: "per_diem",
      headerName: "Per Diem",
      minWidth: 120,
      sortable: true,
      renderCell: (p) => <span>{moneyFmt(p?.row?.per_diem)}</span>,
    },
    {
      field: "labor_rate",
      headerName: "Labor Rate",
      minWidth: 130,
      sortable: true,
      renderCell: (params) => {
        const v = params.row?.labor_rate ?? (params.row as any)?.pay_rate ?? null;
        return <span>{moneyFmt(v)}</span>;
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

        // optimistic add
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

        // optimistic update (includes per_diem/labor_rate)
        setRows((prev) =>
          prev.map((r) =>
            r.employee_id === id ? { ...r, ...rest } : r
          )
        );
      }

      setOpen(false);

      // optional: refresh from server for full fidelity (runs in background)
      fetchRows();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={600}>
          Employees
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Employee
        </Button>
      </Stack>

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
          rows={rows}
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
          {/* simple responsive 2-col form */}
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

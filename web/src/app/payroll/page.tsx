/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import * as React from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import EditIcon from "@mui/icons-material/Edit";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
import AddIcon from "@mui/icons-material/Add";

type Employee = {
  employee_id: string;
  reference?: string | null;
  company?: string | null;
  location?: string | null;
  name?: string | null;
  phone?: string | null;
  position?: string | null;
  labor_rate?: number | string | null;
  per_diem?: number | string | null;
};

export default function PayrollPage(): React.ReactElement {
  const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  const [allRows, setAllRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(false);

  // filters
  const [scope, setScope] = React.useState<"all" | "by">("all");
  const [company, setCompany] = React.useState<string>("(any)");
  const [location, setLocation] = React.useState<string>("(any)");

  // search
  const [query, setQuery] = React.useState<string>("");

  // hours & per-diem days keyed by employee_id (persist across filters/search)
  const [hours, setHours] = React.useState<
    Record<string, { w1?: number; w2?: number; days?: number }>
  >({});

  // edit dialog (for existing employees)
  const [openEditDlg, setOpenEditDlg] = React.useState(false);
  const [editForm, setEditForm] = React.useState<Partial<Employee>>({});
  const [savingEdit, setSavingEdit] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);

  // ADD EMPLOYEE dialog (new!)
  const [openAddDlg, setOpenAddDlg] = React.useState(false);
  const [addForm, setAddForm] = React.useState<Partial<Employee>>({});
  const [savingAdd, setSavingAdd] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);

  // fetch employees
  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/employees?limit=3000`);
      const d = await r.json();
      setAllRows((d?.rows ?? []) as Employee[]);
    } finally {
      setLoading(false);
    }
  }, [API]);

  React.useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // filter options
  const companies = React.useMemo(() => {
    const s = new Set<string>();
    allRows.forEach((r) => r.company && s.add(String(r.company).trim()));
    return ["(any)", ...Array.from(s).sort()];
  }, [allRows]);

  const locations = React.useMemo(() => {
    const s = new Set<string>();
    allRows.forEach((r) => r.location && s.add(String(r.location).trim()));
    return ["(any)", ...Array.from(s).sort()];
  }, [allRows]);

  // base filtered set by scope/company/location
  const scopedRows: Employee[] = React.useMemo(() => {
    if (scope === "all") return allRows;
    return allRows.filter(
      (r) =>
        (company === "(any)" || String(r.company || "").trim() === company) &&
        (location === "(any)" || String(r.location || "").trim() === location)
    );
  }, [allRows, scope, company, location]);

  // final rows: apply multi-field search
  const rows: Employee[] = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopedRows;
    return scopedRows.filter((r) => {
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
  }, [scopedRows, query]);

  // helpers
  const asNum = (v: any): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

  const money = (n: number): string => `$${n.toFixed(2)}`;

  const totalFor = (emp: Employee, h1?: number, h2?: number): { regular: number; ot: number; total: number } => {
    const rate = asNum(emp.labor_rate) ?? 0;
    const a = asNum(h1) ?? 0;
    const b = asNum(h2) ?? 0;

    const reg1 = Math.min(40, a);
    const reg2 = Math.min(40, b);
    const ot1 = Math.max(0, a - 40);
    const ot2 = Math.max(0, b - 40);

    const regularPay = rate * (reg1 + reg2);
    const otPay = rate * 1.5 * (ot1 + ot2);
    return { regular: regularPay, ot: otPay, total: regularPay + otPay };
  };

  const perDiemTotal = (emp: Employee, days?: number) => {
    const d = asNum(days) ?? 0;
    const pd = asNum(emp.per_diem) ?? 0;
    return d * pd;
  };

  const handleHoursChange = (id: string, key: "w1" | "w2" | "days", value: string) => {
    const n = value === "" ? undefined : Number(value);
    setHours((prev) => ({ ...prev, [id]: { ...prev[id], [key]: n } }));
  };

  // ----- Edit existing employee (inline dialog) -----
  const openEdit = (emp: Employee) => {
    setEditForm({ ...emp });
    setEditError(null);
    setOpenEditDlg(true);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      const payload: any = { ...editForm };
      const id = payload.employee_id;
      if (!id) throw new Error("Missing employee_id");
      payload.labor_rate =
        payload.labor_rate === "" || payload.labor_rate == null ? null : Number(payload.labor_rate);
      payload.per_diem =
        payload.per_diem === "" || payload.per_diem == null ? null : Number(payload.per_diem);
      const { employee_id, ...rest } = payload;
      const res = await fetch(`${API}/employees/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      if (!res.ok) throw new Error(await res.text());
      // optimistic update
      setAllRows((prev) => prev.map((r) => (r.employee_id === id ? { ...r, ...rest } : r)));
      setOpenEditDlg(false);
    } catch (e: any) {
      setEditError(e?.message || "Save failed");
    } finally {
      setSavingEdit(false);
    }
  };

  // ----- Add employee (same behavior as Employees page) -----
  const nextEmployeeId = (): string => {
    let maxNum = 0;
    allRows.forEach((r) => {
      const m = /^E(\d{1,})$/.exec(r.employee_id || "");
      if (m) {
        const num = parseInt(m[1], 10);
        if (num > maxNum) maxNum = num;
      }
    });
    const next = maxNum + 1;
    return `E${String(next).padStart(4, "0")}`;
  };

  const openAdd = () => {
    setAddForm({
      employee_id: nextEmployeeId(),
      name: "",
      reference: "",
      company: "",
      location: "",
      position: "",
      phone: "",
      per_diem: "",
      labor_rate: "",
    });
    setAddError(null);
    setOpenAddDlg(true);
  };

  const saveAdd = async () => {
    setSavingAdd(true);
    try {
      const payload: any = { ...addForm };
      if (!payload.employee_id || !payload.name) {
        setAddError("Employee ID and Name are required");
        setSavingAdd(false);
        return;
      }
      payload.labor_rate =
        payload.labor_rate === "" || payload.labor_rate == null ? null : Number(payload.labor_rate);
      payload.per_diem =
        payload.per_diem === "" || payload.per_diem == null ? null : Number(payload.per_diem);

      const res = await fetch(`${API}/employees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());

      // optimistic insert into the full dataset so filters/search include it immediately
      setAllRows((prev) => [payload as Employee, ...prev]);
      setOpenAddDlg(false);
    } catch (e: any) {
      setAddError(e?.message || "Save failed");
    } finally {
      setSavingAdd(false);
    }
  };

  // build payload for backend append-only run (when you need it later)
  const buildRunPayload = () => {
    const items = rows.map((r) => {
      const h = hours[r.employee_id] || {};
      const w1 = asNum(h.w1) || 0;
      const w2 = asNum(h.w2) || 0;
      return {
        employee_id: r.employee_id,
        name: r.name ?? "",
        reference: r.reference ?? "",
        company: r.company ?? "",
        location: r.location ?? "",
        position: r.position ?? "",
        labor_rate: asNum(r.labor_rate) ?? 0,
        week1_hours: w1,
        week2_hours: w2,
      };
    });

    return {
      scope,
      company: scope === "all" ? null : company,
      location: scope === "all" ? null : location,
      note: null,
      items,
      commission: { beneficiary: "danny", per_hour_rate: 0.5 },
    };
  };

  // save to DB (append-only) then export CSV (visible set)
  const saveAndExportCSV = async () => {
    try {
      // Persist run (optional; keeps your previous behavior)
      const payload = buildRunPayload();
      const res = await fetch(`${API}/payroll/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const run = await res.json();

      // Export current rows (respecting filters + search)
      const records = rows.map((r) => {
        const h = hours[r.employee_id] || {};
        const h1 = asNum(h.w1) || 0;
        const h2 = asNum(h.w2) || 0;
        const dayCount = asNum(h.days) || 0;
        const rate = asNum(r.labor_rate) ?? 0;
        const perDiemRate = asNum(r.per_diem) ?? 0;
        const pay = totalFor(r, h1, h2);
        const pdTotal = perDiemRate * dayCount;

        return {
          RunKey: run.run_key,
          EmployeeID: r.employee_id,
          Name: r.name ?? "",
          Reference: r.reference ?? "",
          Company: r.company ?? "",
          Location: r.location ?? "",
          Position: r.position ?? "",
          LaborRate: rate,
          Week1Hours: h1,
          Week2Hours: h2,
          OT_Pay: pay.ot,
          Regular_Pay: pay.regular,
          PerDiemRate: perDiemRate,
          PerDiemDays: dayCount,
          PerDiemTotal: pdTotal,
          TotalHours: h1 + h2,
          CheckTotal: pay.total + pdTotal,
        };
      });

      const headers = Object.keys(records[0] || {});
      const escape = (v: unknown) => {
        if (v == null) return "";
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
      const lines = [
        headers.join(","),
        ...records.map((rec) => headers.map((h) => escape((rec as any)[h])).join(",")),
      ];

      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "payroll.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Save/Export failed: ${e?.message || e}`);
    }
  };

  // columns
  const columns: GridColDef[] = [
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "reference", headerName: "Ref", minWidth: 100 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    {
      field: "labor_rate",
      headerName: "Rate",
      minWidth: 90,
      renderCell: (p: any) => {
        const v = asNum(p?.row?.labor_rate);
        return v == null ? "-" : `$${v.toFixed(2)}`;
      },
    },
    {
      field: "w1",
      headerName: "Week 1",
      minWidth: 110,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const id = p?.row?.employee_id as string | undefined;
        const value = id ? hours[id]?.w1 ?? "" : "";
        return (
          <TextField
            size="small"
            type="number"
            value={value}
            onChange={(e) => id && handleHoursChange(id, "w1", e.target.value)}
            sx={{ width: 100 }}
          />
        );
      },
    },
    {
      field: "w2",
      headerName: "Week 2",
      minWidth: 110,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const id = p?.row?.employee_id as string | undefined;
        const value = id ? hours[id]?.w2 ?? "" : "";
        return (
          <TextField
            size="small"
            type="number"
            value={value}
            onChange={(e) => id && handleHoursChange(id, "w2", e.target.value)}
            sx={{ width: 100 }}
          />
        );
      },
    },
    {
      field: "days",
      headerName: "Per-Diem Days",
      minWidth: 130,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const id = p?.row?.employee_id as string | undefined;
        const value = id ? hours[id]?.days ?? "" : "";
        return (
          <TextField
            size="small"
            type="number"
            value={value}
            onChange={(e) => id && handleHoursChange(id, "days", e.target.value)}
            sx={{ width: 110 }}
          />
        );
      },
    },
    {
      field: "per_diem_total",
      headerName: "Per-Diem $",
      minWidth: 120,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const row = (p?.row ?? {}) as Employee;
        const id = row.employee_id;
        const d = (id && hours[id]?.days) || 0;
        const total = perDiemTotal(row, d);
        return money(total);
      },
    },
    {
      field: "check_total",
      headerName: "Check Total",
      minWidth: 140,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const row = (p?.row ?? {}) as Employee;
        const id = row.employee_id;
        const h = (id && hours[id]) || {};
        const pay = totalFor(row, h?.w1, h?.w2);
        const pd = perDiemTotal(row, h?.days);
        return money(pay.total + pd);
      },
    },
    {
      field: "actions",
      headerName: "Edit",
      width: 80,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => (
        <IconButton size="small" onClick={() => p?.row && openEdit(p.row as Employee)} aria-label="edit">
          <EditIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  return (
    <Stack gap={2}>
      {/* Header & Actions */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={700}>Payroll</Typography>
        <Stack direction="row" gap={1}>
          <Button variant="outlined" startIcon={<AddIcon />} onClick={openAdd}>
            Add Employee
          </Button>
          <Button startIcon={<SaveAltIcon />} variant="contained" onClick={saveAndExportCSV}>
            Save as CSV
          </Button>
        </Stack>
      </Stack>

      {/* Search + Filters */}
      <Box
        sx={{
          p: 2,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 2,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "2fr 1fr 1fr 1fr" },
          gap: 2,
        }}
      >
        <TextField
          label="Search (name, company, location, position, phone, ref, ID)"
          placeholder="Start typing…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          size="small"
        />

        <FormControl size="small">
          <InputLabel>Scope</InputLabel>
          <Select
            label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "all" | "by")}
            startAdornment={<FilterAltIcon sx={{ mr: 1 }} />}
          >
            <MenuItem value="all">All employees</MenuItem>
            <MenuItem value="by">By company & location</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" disabled={scope === "all"}>
          <InputLabel>Company</InputLabel>
          <Select label="Company" value={company} onChange={(e) => setCompany(e.target.value)}>
            {companies.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" disabled={scope === "all"}>
          <InputLabel>Location</InputLabel>
          <Select label="Location" value={location} onChange={(e) => setLocation(e.target.value)}>
            {locations.map((l) => (
              <MenuItem key={l} value={l}>
                {l}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Grid */}
      <Box sx={{ width: "100%", bgcolor: "background.paper", borderRadius: 2 }}>
        <DataGrid
          rows={rows}
          columns={columns as GridColDef[]}
          getRowId={(r) => (r as Employee).employee_id}
          loading={loading}
          disableRowSelectionOnClick
          initialState={{
            pagination: { paginationModel: { pageSize: 25, page: 0 } },
            sorting: { sortModel: [{ field: "name", sort: "asc" }] },
          }}
          pageSizeOptions={[10, 25, 50, 100]}
          sx={{
            borderRadius: 2,
            "& .MuiDataGrid-columnHeaders": { background: "#f3f4f6", fontWeight: 600 },
          }}
        />
      </Box>

      {/* Edit dialog */}
      <Dialog open={openEditDlg} onClose={() => setOpenEditDlg(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Employee</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
            <TextField label="Employee ID" value={editForm.employee_id ?? ""} disabled />
            <TextField label="Name" value={editForm.name ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} />
            <TextField label="Reference" value={editForm.reference ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, reference: e.target.value }))} />
            <TextField label="Company" value={editForm.company ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, company: e.target.value }))} />
            <TextField label="Location" value={editForm.location ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, location: e.target.value }))} />
            <TextField label="Position" value={editForm.position ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, position: e.target.value }))} />
            <TextField label="Phone" value={editForm.phone ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, phone: e.target.value }))} />
            <TextField label="Per Diem" type="number" value={editForm.per_diem ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, per_diem: e.target.value }))} />
            <TextField label="Labor Rate" type="number" value={editForm.labor_rate ?? ""} onChange={(e) => setEditForm((p) => ({ ...p, labor_rate: e.target.value }))} />
          </Box>
          {editError && <Typography color="error" sx={{ mt: 2 }}>{editError}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenEditDlg(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveEdit} disabled={savingEdit}>
            {savingEdit ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add dialog */}
      <Dialog open={openAddDlg} onClose={() => setOpenAddDlg(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Employee</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
            <TextField label="Employee ID *" value={addForm.employee_id ?? ""} disabled />
            <TextField label="Name *" value={addForm.name ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, name: e.target.value }))} />
            <TextField label="Reference" value={addForm.reference ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, reference: e.target.value }))} />
            <TextField label="Company" value={addForm.company ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, company: e.target.value }))} />
            <TextField label="Location" value={addForm.location ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, location: e.target.value }))} />
            <TextField label="Position" value={addForm.position ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, position: e.target.value }))} />
            <TextField label="Phone" value={addForm.phone ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, phone: e.target.value }))} />
            <TextField label="Per Diem" type="number" value={addForm.per_diem ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, per_diem: e.target.value }))} />
            <TextField label="Labor Rate" type="number" value={addForm.labor_rate ?? ""} onChange={(e) => setAddForm((p) => ({ ...p, labor_rate: e.target.value }))} />
          </Box>
          {addError && <Typography color="error" sx={{ mt: 2 }}>{addError}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenAddDlg(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveAdd} disabled={savingAdd}>
            {savingAdd ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

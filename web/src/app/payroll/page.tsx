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
  MenuItem,
  Select,
  FormControl,
  InputLabel,
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import EditIcon from "@mui/icons-material/Edit";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import AddIcon from "@mui/icons-material/Add";
import FilterAltIcon from "@mui/icons-material/FilterAlt";

type Employee = {
  employee_id: string;
  reference?: string | null;
  company?: string | null;
  location?: string | null;
  name?: string | null;
  phone?: string | null;
  position?: string | null;
  labor_rate?: number | string | null;
  per_diem?: number | string | null; // rate per day
};

type HoursState = Record<
  string,
  {
    w1?: number; // week 1 hours
    w2?: number; // week 2 hours
    days?: number; // total days worked in period (for per-diem)
  }
>;

export default function PayrollPage() {
  const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  const [allRows, setAllRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(false);

  // filters
  const [scope, setScope] = React.useState<"all" | "by">("all");
  const [company, setCompany] = React.useState<string>("(any)");
  const [location, setLocation] = React.useState<string>("(any)");

  // search
  const [query, setQuery] = React.useState<string>("");

  // hours keyed by employee_id (persist across filters/search)
  const [hours, setHours] = React.useState<HoursState>({});

  // dialog mode
  const [mode, setMode] = React.useState<"edit" | "create">("edit");
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // fetch employees
  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/employees?limit=2000`);
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
        (company === "(any)" ||
          String(r.company || "").trim() === company) &&
        (location === "(any)" ||
          String(r.location || "").trim() === location)
    );
  }, [allRows, scope, company, location]);

  // final rows: apply name search
  const rows: Employee[] = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopedRows;
    return scopedRows.filter((r) => (r.name || "").toLowerCase().includes(q));
  }, [scopedRows, query]);

  // helpers
  const asNum = (v: any): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

  const perDiemTotalFor = (emp: Employee, days?: number): number => {
    const rate = asNum(emp.per_diem) ?? 0;
    const d = asNum(days) ?? 0;
    return rate * d;
  };

  const checkTotalFor = (emp: Employee, h1?: number, h2?: number): number => {
    const lr = asNum(emp.labor_rate) ?? 0;
    const a = asNum(h1) || 0;
    const b = asNum(h2) || 0;
    return lr * (a + b);
  };

  const handleHoursChange = (
    id: string,
    key: "w1" | "w2" | "days",
    value: string
  ) => {
    const n = value === "" ? undefined : Number(value);
    setHours((prev) => ({ ...prev, [id]: { ...prev[id], [key]: n } }));
  };

  // dialog helpers
  const openEdit = (emp: Employee) => {
    setMode("edit");
    setForm({ ...emp });
    setError(null);
    setOpen(true);
  };

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
      labor_rate: "",
      per_diem: "",
    });
    setError(null);
    setOpen(true);
  };

  const saveDialog = async () => {
    setSaving(true);
    try {
      const payload: any = { ...form };
      // enforce numerics
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
          throw new Error("Employee ID and Name are required");
        }
        const res = await fetch(`${API}/employees`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
      } else {
        const id = payload.employee_id;
        if (!id) throw new Error("Missing employee_id");
        const { employee_id, ...rest } = payload;
        const res = await fetch(`${API}/employees/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rest),
        });
        if (!res.ok) throw new Error(await res.text());
      }

      setOpen(false);
      fetchRows();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // -------- CSV EXPORT (client-only) ----------
  // Any employee who has hours (w1 or w2) OR days > 0 gets exported
  const exportCSV = () => {
    const byId = new Map(allRows.map((r) => [r.employee_id, r]));
    const lines: string[] = [];
    const headers = [
      "EmployeeID",
      "Name",
      "Reference",
      "Company",
      "Location",
      "Position",
      "LaborRate",
      "Week1Hours",
      "Week2Hours",
      "CheckTotal",
      "PerDiemRate",
      "Days",
      "PerDiemTotal",
    ];
    lines.push(headers.join(","));

    for (const [id, h] of Object.entries(hours)) {
      const w1 = Number(h?.w1 ?? 0);
      const w2 = Number(h?.w2 ?? 0);
      const days = Number(h?.days ?? 0);
      if ((w1 || 0) <= 0 && (w2 || 0) <= 0 && (days || 0) <= 0) continue;

      const base = byId.get(id);
      if (!base) continue;

      const rate = asNum(base.labor_rate) ?? 0;
      const check = checkTotalFor(base, w1, w2);
      const perRate = asNum(base.per_diem) ?? 0;
      const perTotal = perRate * days;

      const row = [
        id,
        csvQuote(base.name),
        csvQuote(base.reference),
        csvQuote(base.company),
        csvQuote(base.location),
        csvQuote(base.position),
        rate.toFixed(2),
        w1.toString(),
        w2.toString(),
        check.toFixed(2),
        perRate.toFixed(2),
        days.toString(),
        perTotal.toFixed(2),
      ];

      lines.push(row.join(","));
    }

    if (lines.length === 1) {
      alert("No hours/days to export. Enter Week 1 / Week 2 hours or Days first.");
      return;
    }

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // columns
  const columns: GridColDef<Employee>[] = [
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
      field: "check_total",
      headerName: "Check Total",
      minWidth: 130,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const row = (p?.row ?? {}) as Employee;
        const id = row.employee_id;
        const h = (id && hours[id]) || {};
        const total = checkTotalFor(row, h?.w1, h?.w2);
        return `$${total.toFixed(2)}`;
      },
    },
    {
      field: "per_diem",
      headerName: "Per Diem Rate",
      minWidth: 130,
      renderCell: (p: any) => {
        const v = asNum(p?.row?.per_diem);
        return v == null ? "-" : `$${v.toFixed(2)}`;
      },
    },
    {
      field: "days",
      headerName: "Days",
      minWidth: 90,
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
            sx={{ width: 80 }}
          />
        );
      },
    },
    {
      field: "per_diem_total",
      headerName: "Per Diem Total",
      minWidth: 150,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const row = (p?.row ?? {}) as Employee;
        const id = row.employee_id;
        const d = (id && hours[id]?.days) || 0;
        const total = perDiemTotalFor(row, d);
        return `$${total.toFixed(2)}`;
      },
    },
    {
      field: "actions",
      headerName: "Edit",
      width: 80,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => (
        <IconButton
          size="small"
          onClick={() => p?.row && openEdit(p.row as Employee)}
          aria-label="edit"
        >
          <EditIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  return (
    <Stack gap={2}>
      {/* Header & Actions */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={700}>
          Payroll
        </Typography>
        <Stack direction="row" gap={1}>
          <Button startIcon={<AddIcon />} variant="outlined" onClick={openCreate}>
            Add Employee
          </Button>
          <Button startIcon={<SaveAltIcon />} variant="contained" onClick={exportCSV}>
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
          label="Search by name"
          placeholder="Start typing a name…"
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
          <Select
            label="Company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          >
            {companies.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" disabled={scope === "all"}>
          <InputLabel>Location</InputLabel>
          <Select
            label="Location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          >
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
        <DataGrid<Employee>
          rows={rows}
          columns={columns}
          getRowId={(r) => r.employee_id}
          loading={loading}
          disableRowSelectionOnClick
          initialState={{
            pagination: { paginationModel: { pageSize: 25, page: 0 } },
            sorting: { sortModel: [{ field: "name", sort: "asc" }] },
          }}
          pageSizeOptions={[10, 25, 50, 100]}
          sx={{
            borderRadius: 2,
            "& .MuiDataGrid-columnHeaders": {
              background: "#f3f4f6",
              fontWeight: 600,
            },
          }}
        />
      </Box>

      {/* Create/Edit dialog */}
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
              label="Employee ID"
              value={form.employee_id ?? ""}
              disabled={mode === "edit"}
              onChange={(e) =>
                setForm((p) => ({ ...p, employee_id: e.target.value }))
              }
            />
            <TextField
              label="Name"
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
              onChange={(e) =>
                setForm((p) => ({ ...p, company: e.target.value }))
              }
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
              label="Labor Rate"
              type="number"
              value={form.labor_rate ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, labor_rate: e.target.value }))
              }
            />
            <TextField
              label="Per Diem (per day)"
              type="number"
              value={form.per_diem ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, per_diem: e.target.value }))
              }
            />
          </Box>
          {error && <Typography color="error" sx={{ mt: 2 }}>{error}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveDialog} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/** CSV quoting helper */
function csvQuote(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

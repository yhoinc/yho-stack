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

type HoursMap = Record<string, { w1?: number; w2?: number; days?: number }>;

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

  // user-entered hours/days
  const [hours, setHours] = React.useState<HoursMap>({});

  // overtime settings (editable in UI)
  const [otThreshold, setOtThreshold] = React.useState<number>(40); // weekly
  const [otMultiplier, setOtMultiplier] = React.useState<number>(1.5);

  // dialog state
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

  // scope + filters
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

  // search
  const rows: Employee[] = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopedRows;
    return scopedRows.filter((r) => (r.name || "").toLowerCase().includes(q));
  }, [scopedRows, query]);

  // helpers
  const asNum = (v: any): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

  function splitOvertime(h: number, threshold: number) {
    const reg = Math.min(h, threshold);
    const ot = Math.max(h - threshold, 0);
    return { reg, ot };
  }

  function hourlyTotals(emp: Employee, w1?: number, w2?: number) {
    const rate = asNum(emp.labor_rate) ?? 0;
    const t = Number(otThreshold) || 40;
    const m = Number(otMultiplier) || 1.5;

    const h1 = asNum(w1) || 0;
    const h2 = asNum(w2) || 0;

    const s1 = splitOvertime(h1, t);
    const s2 = splitOvertime(h2, t);

    const regHours = s1.reg + s2.reg;
    const otHours = s1.ot + s2.ot;

    const regPay = rate * regHours;
    const otPay = rate * m * otHours;
    const total = regPay + otPay;

    return { regHours, otHours, regPay, otPay, total, rate, t, m, h1, h2 };
  }

  function perDiemTotal(emp: Employee, days?: number) {
    const pdRate = asNum(emp.per_diem) ?? 0;
    const d = asNum(days) ?? 0;
    return pdRate * d;
  }

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

  // CSV export (includes OT breakdown + per-diem)
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
      "Rate",
      "W1_Hours",
      "W2_Hours",
      "RegHours",
      "OTHours",
      "RegPay",
      "OTPay",
      "HourlyTotal",
      "PerDiemRate",
      "Days",
      "PerDiemTotal",
      "GrandTotal",
      "OT_Threshold",
      "OT_Multiplier",
    ];
    lines.push(headers.join(","));

    let any = false;
    for (const [id, h] of Object.entries(hours)) {
      const w1 = Number(h?.w1 ?? 0);
      const w2 = Number(h?.w2 ?? 0);
      const days = Number(h?.days ?? 0);
      if (w1 <= 0 && w2 <= 0 && days <= 0) continue;

      const emp = byId.get(id);
      if (!emp) continue;

      any = true;
      const ot = hourlyTotals(emp, w1, w2);
      const pdRate = asNum(emp.per_diem) ?? 0;
      const pdTotal = perDiemTotal(emp, days);
      const grand = ot.total + pdTotal;

      const row = [
        id,
        csvQuote(emp.name),
        csvQuote(emp.reference),
        csvQuote(emp.company),
        csvQuote(emp.location),
        csvQuote(emp.position),
        ot.rate.toFixed(2),
        w1.toString(),
        w2.toString(),
        ot.regHours.toFixed(2),
        ot.otHours.toFixed(2),
        ot.regPay.toFixed(2),
        ot.otPay.toFixed(2),
        ot.total.toFixed(2),
        pdRate.toFixed(2),
        days.toString(),
        pdTotal.toFixed(2),
        grand.toFixed(2),
        ot.t.toString(),
        ot.m.toString(),
      ];

      lines.push(row.join(","));
    }

    if (!any) {
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

  // columns (kept loose-typed to avoid TS “never/row” issues)
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
      field: "check_total",
      headerName: "Hourly Check (incl. OT)",
      minWidth: 170,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const emp = (p?.row ?? {}) as Employee;
        const id = emp.employee_id;
        const h = (id && hours[id]) || {};
        const ot = hourlyTotals(emp, h?.w1, h?.w2);
        return `$${ot.total.toFixed(2)}`;
      },
    },
    {
      field: "per_diem_rate",
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
      minWidth: 140,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const emp = (p?.row ?? {}) as Employee;
        const id = emp.employee_id;
        const d = (id && hours[id]?.days) || 0;
        const total = perDiemTotal(emp, d);
        return `$${total.toFixed(2)}`;
      },
    },
    {
      field: "grand_total",
      headerName: "Grand Total",
      minWidth: 140,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const emp = (p?.row ?? {}) as Employee;
        const id = emp.employee_id;
        const h = (id && hours[id]) || {};
        const ot = hourlyTotals(emp, h?.w1, h?.w2);
        const pd = perDiemTotal(emp, h?.days);
        return `$${(ot.total + pd).toFixed(2)}`;
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

      {/* Search + Filters + OT Settings */}
      <Box
        sx={{
          p: 2,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 2,
          display: "grid",
          gridTemplateColumns: {
            xs: "1fr",
            md: "2fr 1fr 1fr 1fr 120px 140px",
          },
          gap: 2,
          alignItems: "center",
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

        <TextField
          size="small"
          label="OT threshold (hrs/wk)"
          type="number"
          value={otThreshold}
          onChange={(e) => setOtThreshold(Number(e.target.value || 0))}
        />
        <TextField
          size="small"
          label="OT multiplier"
          type="number"
          value={otMultiplier}
          onChange={(e) => setOtMultiplier(Number(e.target.value || 0))}
        />
      </Box>

      {/* Grid */}
      <Box sx={{ width: "100%", bgcolor: "background.paper", borderRadius: 2 }}>
        <DataGrid
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
        <DialogTitle>{mode === "create" ? "Add Employee" : "Edit Employee"}</DialogTitle>
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

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
import { DataGrid, GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import EditIcon from "@mui/icons-material/Edit";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
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
  per_diem?: number | string | null;        // rate per day
  timesheet_name?: string | null;
  quickbooks_name?: string | null;          // NEW: show + export
};

type HoursMap = Record<string, { w1?: number; w2?: number; pd?: number }>;

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

  // hours + per-diem days keyed by employee_id
  const [hours, setHours] = React.useState<HoursMap>({});

  // edit dialog
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
        (company === "(any)" || String(r.company || "").trim() === company) &&
        (location === "(any)" || String(r.location || "").trim() === location)
    );
  }, [allRows, scope, company, location]);

  // final rows: apply name search
  const rows: Employee[] = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopedRows;
    return scopedRows.filter((r) =>
      (r.name || "").toLowerCase().includes(q)
    );
  }, [scopedRows, query]);

  // ------- helpers -------
  const asNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const money = (v: number | null | undefined): string =>
    !v || Number.isNaN(v) ? "$0.00" : `$${v.toFixed(2)}`;

  // OT: everything over 40 in (w1+w2) is 1.5×
  const wagesFor = (emp: Employee, h1?: number, h2?: number): number => {
    const rate = asNum(emp.labor_rate) ?? 0;
    const totalHrs = (asNum(h1) ?? 0) + (asNum(h2) ?? 0);
    const straight = Math.min(40, totalHrs);
    const ot = Math.max(0, totalHrs - 40);
    return straight * rate + ot * rate * 1.5;
  };

  const perDiemTotalFor = (emp: Employee, pdDays?: number): number => {
    const rate = asNum(emp.per_diem) ?? 0;
    const days = asNum(pdDays) ?? 0;
    return rate * days;
  };

  const grandTotalFor = (emp: Employee, h1?: number, h2?: number, pdDays?: number): number => {
    return wagesFor(emp, h1, h2) + perDiemTotalFor(emp, pdDays);
  };

  const handleHoursChange = (id: string, key: "w1" | "w2", value: string) => {
    const n = value === "" ? undefined : Number(value);
    setHours((prev) => ({ ...prev, [id]: { ...prev[id], [key]: n } }));
  };
  const handlePerDiemDaysChange = (id: string, value: string) => {
    const n = value === "" ? undefined : Number(value);
    setHours((prev) => ({ ...prev, [id]: { ...prev[id], pd: n } }));
  };

  // ------- edit dialog -------
  const openEdit = (emp: Employee) => {
    setForm({ ...emp });
    setError(null);
    setOpen(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const payload: Partial<Employee> = { ...form };
      const id = payload.employee_id;
      if (!id) throw new Error("Missing employee_id");

      // numeric coercions
      if (payload.labor_rate !== undefined)
        payload.labor_rate =
          payload.labor_rate === "" || payload.labor_rate == null
            ? null
            : Number(payload.labor_rate);
      if (payload.per_diem !== undefined)
        payload.per_diem =
          payload.per_diem === "" || payload.per_diem == null
            ? null
            : Number(payload.per_diem);

      const { employee_id, ...rest } = payload;
      const res = await fetch(`${API}/employees/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      if (!res.ok) throw new Error(await res.text());
      setOpen(false);
      fetchRows();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // ------- optional: persist run (best-effort, OK if 404) + export CSV -------
  const saveAndExportCSV = async () => {
    // Build items using current visible rows (respect filters + search)
    const items = rows.map((r) => {
      const h = hours[r.employee_id] || {};
      const h1 = asNum(h.w1) ?? 0;
      const h2 = asNum(h.w2) ?? 0;
      const pd = asNum(h.pd) ?? 0;
      const rate = asNum(r.labor_rate) ?? 0;

      const wages = wagesFor(r, h1, h2);
      const perDiem = perDiemTotalFor(r, pd);
      const total = wages + perDiem;

      return {
        employee_id: r.employee_id,
        name: r.name ?? "",
        quickbooks_name: r.quickbooks_name ?? "",   // <— include in export
        reference: r.reference ?? "",
        company: r.company ?? "",
        location: r.location ?? "",
        position: r.position ?? "",
        labor_rate: rate,
        week1_hours: h1,
        week2_hours: h2,
        per_diem_rate: asNum(r.per_diem) ?? 0,
        per_diem_days: pd,
        wages,
        per_diem_total: perDiem,
        grand_total: total,
      };
    });

    // Best-effort POST (if backend supports it). Ignore failures.
    try {
      await fetch(`${API}/payroll/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          company: scope === "all" ? null : company,
          location: scope === "all" ? null : location,
          note: null,
          items,
          commission: { beneficiary: "danny", per_hour_rate: 0.5 },
        }),
      });
    } catch {
      // ignore
    }

    // CSV export
    const headers = [
      "EmployeeID",
      "Name",
      "QuickBooksName",
      "Reference",
      "Company",
      "Location",
      "Position",
      "LaborRate",
      "Week1Hours",
      "Week2Hours",
      "PerDiemRate",
      "PerDiemDays",
      "Wages",
      "PerDiemTotal",
      "GrandTotal",
    ];

    const lines = [
      headers.join(","),
      ...items.map((it) =>
        [
          it.employee_id,
          csv(it.name),
          csv(it.quickbooks_name),
          csv(it.reference),
          csv(it.company),
          csv(it.location),
          csv(it.position),
          num(it.labor_rate),
          num(it.week1_hours),
          num(it.week2_hours),
          num(it.per_diem_rate),
          num(it.per_diem_days),
          num(it.wages),
          num(it.per_diem_total),
          num(it.grand_total),
        ].join(",")
      ),
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
  };

  const csv = (s: string | number | null | undefined): string => {
    if (s === null || s === undefined) return "";
    const str = String(s);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    // minimal CSV-escaping
  };
  const num = (n: number | null | undefined): string =>
    n == null || Number.isNaN(n) ? "" : String(n);

  // ------- columns -------
  const columns: GridColDef<Employee>[] = [
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "quickbooks_name", headerName: "QuickBooks Name", minWidth: 180 }, // visible + editable in dialog
    { field: "reference", headerName: "Ref", minWidth: 100 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    {
      field: "labor_rate",
      headerName: "Rate",
      minWidth: 90,
      renderCell: (p: GridRenderCellParams<Employee, unknown>) => {
        const v = asNum(p.row?.labor_rate);
        return v == null ? "-" : `$${v.toFixed(2)}`;
      },
    },
    {
      field: "w1",
      headerName: "Week 1",
      minWidth: 110,
      sortable: false,
      filterable: false,
      renderCell: (p: GridRenderCellParams<Employee, unknown>) => {
        const id = p.row?.employee_id;
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
      renderCell: (p: GridRenderCellParams<Employee, unknown>) => {
        const id = p.row?.employee_id;
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
      field: "per_diem_days",
      headerName: "Per Diem Days",
      minWidth: 140,
      sortable: false,
      filterable: false,
      renderCell: (p: GridRenderCellParams<Employee, unknown>) => {
        const id = p.row?.employee_id;
        const value = id ? hours[id]?.pd ?? "" : "";
        return (
          <TextField
            size="small"
            type="number"
            value={value}
            onChange={(e) => id && handlePerDiemDaysChange(id!, e.target.value)}
            sx={{ width: 120 }}
          />
        );
      },
    },
    {
      field: "per_diem_total",
      headerName: "Per Diem $",
      minWidth: 130,
      sortable: false,
      filterable: false,
      valueGetter: (p) => {
        const id = (p.row as Employee).employee_id;
        const h = hours[id] || {};
        return perDiemTotalFor(p.row as Employee, h.pd);
      },
      valueFormatter: (p) => money(Number(p.value || 0)),
    },
    {
      field: "check_total",
      headerName: "Total $",
      minWidth: 140,
      sortable: false,
      filterable: false,
      valueGetter: (p) => {
        const row = p.row as Employee;
        const id = row.employee_id;
        const h = hours[id] || {};
        return grandTotalFor(row, h.w1, h.w2, h.pd);
      },
      valueFormatter: (p) => money(Number(p.value || 0)),
    },
    {
      field: "actions",
      headerName: "Edit",
      width: 80,
      sortable: false,
      filterable: false,
      renderCell: (p: GridRenderCellParams<Employee, unknown>) => (
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
            <MenuItem value="by">By company &amp; location</MenuItem>
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
            "& .MuiDataGrid-columnHeaders": { background: "#f3f4f6", fontWeight: 600 },
          }}
        />
      </Box>

      {/* Edit dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Edit Employee</DialogTitle>
        <DialogContent dividers>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
              gap: 2,
            }}
          >
            <TextField label="Employee ID" value={form.employee_id ?? ""} disabled />
            <TextField
              label="Name"
              value={form.name ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
            <TextField
              label="QuickBooks Name"
              value={form.quickbooks_name ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, quickbooks_name: e.target.value }))}
            />
            <TextField
              label="Timesheet Name"
              value={form.timesheet_name ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, timesheet_name: e.target.value }))}
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
              label="Labor Rate"
              type="number"
              value={form.labor_rate ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, labor_rate: e.target.value }))}
            />
            <TextField
              label="Per Diem (rate/day)"
              type="number"
              value={form.per_diem ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, per_diem: e.target.value }))}
            />
          </Box>
          {error && (
            <Typography color="error" sx={{ mt: 2 }}>
              {error}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveEdit} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

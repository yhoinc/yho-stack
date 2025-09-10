"use client";
import * as React from "react";
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, Stack, TextField, Typography, MenuItem, Select,
  FormControl, InputLabel
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import EditIcon from "@mui/icons-material/Edit";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
import UploadIcon from "@mui/icons-material/Upload";
import * as XLSX from "xlsx";

type Employee = {
  employee_id: string;
  reference?: string | null;
  company?: string | null;
  location?: string | null;
  name?: string | null;
  phone?: string | null;
  position?: string | null;
  labor_rate?: number | string | null;
  per_diem?: number | string | null;           // per-day rate
  timesheet_name?: string | null;              // alias used on timesheets
};

type RowHours = { w1?: number; w2?: number; days?: number };

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
  const [hours, setHours] = React.useState<Record<string, RowHours>>({});

  // edit dialog
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // upload ref for timesheet
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

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

  React.useEffect(() => { fetchRows(); }, [fetchRows]);

  // filter options
  const companies = React.useMemo(() => {
    const s = new Set<string>();
    allRows.forEach(r => r.company && s.add(String(r.company).trim()));
    return ["(any)", ...Array.from(s).sort()];
  }, [allRows]);

  const locations = React.useMemo(() => {
    const s = new Set<string>();
    allRows.forEach(r => r.location && s.add(String(r.location).trim()));
    return ["(any)", ...Array.from(s).sort()];
  }, [allRows]);

  // base filtered set by scope/company/location
  const scopedRows: Employee[] = React.useMemo(() => {
    if (scope === "all") return allRows;
    return allRows.filter(r =>
      (company === "(any)" || String(r.company || "").trim() === company) &&
      (location === "(any)" || String(r.location || "").trim() === location)
    );
  }, [allRows, scope, company, location]);

  // final rows: apply name search
  const rows: Employee[] = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopedRows;
    return scopedRows.filter(r =>
      [r.name, r.employee_id, r.reference, r.company, r.location, r.position, r.timesheet_name]
        .filter(Boolean)
        .some(s => String(s).toLowerCase().includes(q))
    );
  }, [scopedRows, query]);

  // helpers
  const asNum = (v: any): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

  // --- OVERTIME LOGIC (per week, then summed) ---
  // returns {straight, ot} for a single week's hours
  const splitWeek = (weekHours: number) => {
    const straight = Math.min(40, Math.max(0, weekHours));
    const ot = Math.max(0, weekHours - 40);
    return { straight, ot };
  };

  // wages for both weeks with separate OT per week
  const wagesFor = (emp: Employee, h1?: number, h2?: number): number => {
    const rate = asNum(emp.labor_rate) ?? 0;
    const w1 = asNum(h1) ?? 0;
    const w2 = asNum(h2) ?? 0;
    const s1 = splitWeek(w1);
    const s2 = splitWeek(w2);
    const straight = s1.straight + s2.straight;
    const ot = s1.ot + s2.ot;
    return straight * rate + ot * rate * 1.5;
  };

  const perDiemTotalFor = (emp: Employee, days?: number): number => {
    const rate = asNum(emp.per_diem) || 0;
    const d = asNum(days) || 0;
    return rate * d;
  };

  const handleHoursChange = (id: string, key: "w1" | "w2" | "days", value: string) => {
    const n = value === "" ? undefined : Number(value);
    setHours(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: n } }));
  };

  // edit dialog functions
  const openEdit = (emp: Employee) => {
    setForm({ ...emp });
    setError(null);
    setOpen(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const payload: any = { ...form };
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
      setOpen(false);
      fetchRows();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally { setSaving(false); }
  };

  // build payload for backend append-only run
  const buildRunPayload = () => {
    const items = rows.map((r) => {
      const h = hours[r.employee_id] || {};
      const w1 = asNum(h.w1) || 0;
      const w2 = asNum(h.w2) || 0;
      const d  = asNum(h.days) || 0;
      return {
        employee_id: r.employee_id,
        name: r.name ?? "",
        reference: r.reference ?? "",
        company: r.company ?? "",
        location: r.location ?? "",
        position: r.position ?? "",
        labor_rate: asNum(r.labor_rate) ?? 0,
        per_diem: asNum(r.per_diem) ?? 0,
        week1_hours: w1,
        week2_hours: w2,
        days: d,
      };
    });

    return {
      scope,
      company: scope === "all" ? null : company,
      location: scope === "all" ? null : location,
      note: null,
      items,
      commission: { beneficiary: "danny", per_hour_rate: 0.50 },
    };
  };

  // save to DB (append-only) then export Excel
  const saveAndExport = async () => {
    try {
      const payload = buildRunPayload();
      const res = await fetch(`${API}/payroll/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const run = await res.json();

      const records = rows.map((r) => {
        const h = hours[r.employee_id] || {};
        const h1 = asNum(h.w1) || 0;
        const h2 = asNum(h.w2) || 0;
        const d  = asNum(h.days) || 0;
        const rate = asNum(r.labor_rate) ?? 0;
        const pdRate = asNum(r.per_diem) ?? 0;

        // straight/OT per week
        const w1s = splitWeek(h1);
        const w2s = splitWeek(h2);
        const straightHours = w1s.straight + w2s.straight;
        const overtimeHours = w1s.ot + w2s.ot;

        const straightPay = straightHours * rate;
        const overtimePay = overtimeHours * rate * 1.5;
        const wages = straightPay + overtimePay;

        const pdTotal = pdRate * d;

        return {
          RunKey: run.run_key,
          EmployeeID: r.employee_id,
          Name: r.name ?? "",
          TimesheetName: r.timesheet_name ?? "",
          Reference: r.reference ?? "",
          Company: r.company ?? "",
          Location: r.location ?? "",
          Position: r.position ?? "",
          LaborRate: rate,
          Week1Hours: h1,
          Week2Hours: h2,
          StraightHours: straightHours,
          OvertimeHours: overtimeHours,
          StraightPay: straightPay,
          OvertimePay: overtimePay,
          PerDiemRate: pdRate,
          PerDiemDays: d,
          PerDiemTotal: pdTotal,
          WagesTotal: wages,
          GrandTotal: wages + pdTotal,
        };
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(records);
      XLSX.utils.book_append_sheet(wb, ws, "Payroll");

      const c = run.commission || {};
      const ws2 = XLSX.utils.json_to_sheet([{
        Beneficiary: c.beneficiary,
        PerHourRate: c.per_hour_rate,
        SourceHours: c.source_hours,
        TotalCommission: c.total_commission,
        RunKey: run.run_key,
      }]);
      XLSX.utils.book_append_sheet(wb, ws2, "Commission");

      XLSX.writeFile(wb, "payroll.xlsx");
    } catch (e: any) {
      alert(`Save/Export failed: ${e?.message || e}`);
    }
  };

  // Upload timesheet -> populate week 1 hours; auto-download unmatched CSV
  const triggerUpload = () => fileInputRef.current?.click();
  const onUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(`${API}/timesheet/parse`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json(); // { matched, unmatched }

      const next: Record<string, RowHours> = { ...hours };
      for (const m of data.matched || []) {
        const id = String(m.employee_id);
        if (!id) continue;
        const v = Number(m.hours || 0);
        next[id] = { ...(next[id] || {}), w1: v }; // fill Week 1
      }
      setHours(next);

      const u = (data.unmatched || []) as Array<{ name: string; reason?: string; hours?: number }>;
      if (u.length) {
        const csv = [
          "name,reason,hours",
          ...u.map(
            (r) =>
              `"${(r.name || "").replace(/"/g, '""')}",` +
              `"${(r.reason || "").replace(/"/g, '""')}",` +
              `${r.hours ?? ""}`
          ),
        ].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "unmatched.csv";
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(url);
        a.remove();
      }
    } catch (err: any) {
      alert(`Timesheet parse failed: ${err?.message || err}`);
    } finally {
      e.target.value = "";
    }
  };

  // columns
  const columns: GridColDef<Employee>[] = [
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "timesheet_name", headerName: "Timesheet Name", flex: 1, minWidth: 220 },
    { field: "reference", headerName: "Ref", minWidth: 100 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },

    // Hourly rate (wages)
    {
      field: "labor_rate",
      headerName: "Rate",
      minWidth: 90,
      renderCell: (p: any) => {
        const v = asNum(p?.row?.labor_rate);
        return v == null ? "-" : `$${v.toFixed(2)}`;
      },
    },

    // Week 1 / Week 2 inputs (hours)
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

    // Wages total using per-week OT
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
        const total = wagesFor(row, h?.w1, h?.w2);
        return `$${total.toFixed(2)}`;
      },
    },

    // Per Diem rate (read-only)
    {
      field: "per_diem",
      headerName: "Per Diem Rate",
      minWidth: 140,
      renderCell: (p: any) => {
        const v = asNum(p?.row?.per_diem);
        return v == null ? "-" : `$${v.toFixed(2)}`;
      },
    },

    // Per Diem days (input)
    {
      field: "pd_days",
      headerName: "Days",
      minWidth: 100,
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
            sx={{ width: 90 }}
          />
        );
      },
    },

    // Per Diem total (rate * days)
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

    // Edit
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
        <Typography variant="h5" fontWeight={700}>Payroll</Typography>
        <Stack direction="row" gap={1}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xlsm,.xls"
            style={{ display: "none" }}
            onChange={onUploadFile}
          />
          <Button startIcon={<UploadIcon />} variant="outlined" onClick={triggerUpload}>
            Upload Timesheet
          </Button>
          <Button startIcon={<SaveAltIcon />} variant="contained" onClick={saveAndExport}>
            Save as Excel
          </Button>
        </Stack>
      </Stack>

      {/* Search + Filters */}
      <Box
        sx={{
          p: 2, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 2,
          display: "grid", gridTemplateColumns: { xs: "1fr", sm: "2fr 1fr 1fr 1fr" }, gap: 2
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
          <Select label="Company" value={company} onChange={(e) => setCompany(e.target.value)}>
            {companies.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </Select>
        </FormControl>

        <FormControl size="small" disabled={scope === "all"}>
          <InputLabel>Location</InputLabel>
          <Select label="Location" value={location} onChange={(e) => setLocation(e.target.value)}>
            {locations.map((l) => <MenuItem key={l} value={l}>{l}</MenuItem>)}
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
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Employee</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
            <TextField label="Employee ID" value={form.employee_id ?? ""} disabled />
            <TextField label="Name" value={form.name ?? ""} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} />
            <TextField
              label="Timesheet Name"
              value={form.timesheet_name ?? ""}
              onChange={(e) => setForm(p => ({ ...p, timesheet_name: e.target.value }))}
            />
            <TextField label="Reference" value={form.reference ?? ""} onChange={(e) => setForm(p => ({ ...p, reference: e.target.value }))} />
            <TextField label="Company" value={form.company ?? ""} onChange={(e) => setForm(p => ({ ...p, company: e.target.value }))} />
            <TextField label="Location" value={form.location ?? ""} onChange={(e) => setForm(p => ({ ...p, location: e.target.value }))} />
            <TextField label="Position" value={form.position ?? ""} onChange={(e) => setForm(p => ({ ...p, position: e.target.value }))} />
            <TextField label="Phone" value={form.phone ?? ""} onChange={(e) => setForm(p => ({ ...p, phone: e.target.value }))} />
            <TextField label="Labor Rate" type="number" value={form.labor_rate ?? ""} onChange={(e) => setForm(p => ({ ...p, labor_rate: e.target.value }))} />
            <TextField label="Per Diem Rate" type="number" value={form.per_diem ?? ""} onChange={(e) => setForm(p => ({ ...p, per_diem: e.target.value }))} />
          </Box>
          {error && <Typography color="error" sx={{ mt: 2 }}>{error}</Typography>}
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

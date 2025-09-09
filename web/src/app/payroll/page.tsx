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
import UploadFileIcon from "@mui/icons-material/UploadFile";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
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
  per_diem?: number | string | null;
};

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
  const [hours, setHours] = React.useState<Record<string, { w1?: number; w2?: number }>>({});

  // edit dialog
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

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
    return scopedRows.filter(r => (r.name || "").toLowerCase().includes(q));
  }, [scopedRows, query]);

  // helpers
  const asNum = (v: any): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

  const totalFor = (emp: Employee, h1?: number, h2?: number): number => {
    const lr = asNum(emp.labor_rate);
    const a = asNum(h1) || 0;
    const b = asNum(h2) || 0;
    return lr == null ? 0 : lr * (a + b);
  };

  const handleHoursChange = (id: string, key: "w1" | "w2", value: string) => {
    const n = value === "" ? undefined : Number(value);
    setHours(prev => ({ ...prev, [id]: { ...prev[id], [key]: n } }));
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

  // export visible rows + hours as CSV
  const saveAsCSV = () => {
    const records = rows.map((r) => {
      const h = hours[r.employee_id] || {};
      const h1 = asNum(h.w1) || 0;
      const h2 = asNum(h.w2) || 0;
      const rate = asNum(r.labor_rate) ?? 0;
      return {
        EmployeeID: r.employee_id,
        Name: r.name ?? "",
        Reference: r.reference ?? "",
        Company: r.company ?? "",
        Location: r.location ?? "",
        Position: r.position ?? "",
        LaborRate: rate,
        Week1Hours: h1,
        Week2Hours: h2,
        TotalHours: h1 + h2,
        CheckTotal: rate * (h1 + h2),
      };
    });
    const ws = XLSX.utils.json_to_sheet(records);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Payroll");
    XLSX.writeFile(wb, "payroll.csv");
  };

  // upload timesheet -> fill week1 hours; download unmatched
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const triggerUpload = () => fileInputRef.current?.click();

  const onUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(`${API}/payroll/timesheet/upload`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as {
        matches: { employee_id: string; timesheet_name: string; week1_hours: number }[];
        unmatched: { name: string; hours: number | null; reason: string }[];
        matched_count: number;
        unmatched_count: number;
      };

      setHours((prev) => {
        const next = { ...prev };
        for (const m of data.matches) {
          next[m.employee_id] = { ...(next[m.employee_id] || {}), w1: m.week1_hours };
        }
        return next;
      });

      if (data.unmatched?.length) {
        const rows = data.unmatched.map(u => ({
          name: u.name,
          reason: u.reason,
          hours: u.hours ?? "",
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Unmatched");
        XLSX.writeFile(wb, "unmatched_timesheet_rows.csv");
      }

      alert(`Timesheet processed. Matched: ${data.matched_count}, Unmatched: ${data.unmatched_count}`);
    } catch (err: any) {
      alert(`Upload failed: ${err?.message || err}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
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
      field: "check_total",
      headerName: "Check Total",
      minWidth: 140,
      sortable: false,
      filterable: false,
      renderCell: (p: any) => {
        const row = (p?.row ?? {}) as Employee;
        const id = row.employee_id;
        const h = (id && hours[id]) || {};
        const total = totalFor(row, h?.w1, h?.w2);
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
        <Typography variant="h5" fontWeight={700}>Payroll</Typography>
        <Stack direction="row" gap={1}>
          <Button startIcon={<UploadFileIcon />} variant="outlined" onClick={triggerUpload}>
            Upload Timesheet
          </Button>
          <Button startIcon={<SaveAltIcon />} variant="contained" onClick={saveAsCSV}>
            Save as CSV
          </Button>
        </Stack>
      </Stack>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xls,.xlsx"
        style={{ display: "none" }}
        onChange={onUploadFile}
      />

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
        <DataGrid
          rows={rows}
          columns={columns}
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
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Employee</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
            <TextField label="Employee ID" value={form.employee_id ?? ""} disabled />
            <TextField label="Name" value={form.name ?? ""} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} />
            <TextField label="Reference" value={form.reference ?? ""} onChange={(e) => setForm(p => ({ ...p, reference: e.target.value }))} />
            <TextField label="Company" value={form.company ?? ""} onChange={(e) => setForm(p => ({ ...p, company: e.target.value }))} />
            <TextField label="Location" value={form.location ?? ""} onChange={(e) => setForm(p => ({ ...p, location: e.target.value }))} />
            <TextField label="Position" value={form.position ?? ""} onChange={(e) => setForm(p => ({ ...p, position: e.target.value }))} />
            <TextField label="Phone" value={form.phone ?? ""} onChange={(e) => setForm(p => ({ ...p, phone: e.target.value }))} />
            <TextField label="Labor Rate" type="number" value={form.labor_rate ?? ""} onChange={(e) => setForm(p => ({ ...p, labor_rate: e.target.value }))} />
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

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
import UploadFileIcon from "@mui/icons-material/UploadFile";
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
  per_diem?: number | string | null;
  timesheet_name?: string | null;
  quickbooks_name?: string | null;
};

type HoursEntry = { w1?: number; w2?: number; pd?: number };
type HoursMap = Record<string, HoursEntry>;

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
  const [hours, setHours] = React.useState<HoursMap>({});

  // edit/create dialog
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"edit" | "create">("edit");
  const [form, setForm] = React.useState<Partial<Employee>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // upload ref
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // ---------------- data load ----------------
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

  // -------------- filter options --------------
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

  // -------------- scope + search --------------
  const scopedRows: Employee[] = React.useMemo(() => {
    if (scope === "all") return allRows;
    return allRows.filter(
      (r) =>
        (company === "(any)" || String(r.company || "").trim() === company) &&
        (location === "(any)" || String(r.location || "").trim() === location)
    );
  }, [allRows, scope, company, location]);

  const rows: Employee[] = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopedRows;
    return scopedRows.filter(
      (r) =>
        (r.name || "").toLowerCase().includes(q) ||
        (r.quickbooks_name || "").toLowerCase().includes(q) ||
        (r.timesheet_name || "").toLowerCase().includes(q)
    );
  }, [scopedRows, query]);

  // -------------- helpers --------------
  const asNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const money = (v: number | null | undefined): string =>
    v == null || Number.isNaN(v) ? "$0.00" : `$${v.toFixed(2)}`;

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
  const grandTotalFor = (emp: Employee, h1?: number, h2?: number, pdDays?: number): number =>
    wagesFor(emp, h1, h2) + perDiemTotalFor(emp, pdDays);

  const handleHoursChange = (id: string, key: "w1" | "w2", value: string) => {
    const n = value === "" ? undefined : Number(value);
    setHours((prev) => ({ ...prev, [id]: { ...prev[id], [key]: n } }));
  };
  const handlePerDiemDaysChange = (id: string, value: string) => {
    const n = value === "" ? undefined : Number(value);
    setHours((prev) => ({ ...prev, [id]: { ...prev[id], pd: n } }));
  };

  // -------------- edit/create dialog --------------
  const openEdit = (emp: Employee) => {
    setMode("edit");
    setForm({ ...emp });
    setError(null);
    setOpen(true);
  };

  const nextEmployeeId = React.useCallback((): string => {
    const nums = allRows
      .map((r) => r.employee_id)
      .map((id) => {
        const m = /^E(\d{1,})$/.exec(id || "");
        return m ? Number(m[1]) : null;
      })
      .filter((n): n is number => n !== null);
    const max = nums.length ? Math.max(...nums) : 0;
    const next = max + 1;
    return `E${String(next).padStart(4, "0")}`;
  }, [allRows]);

  const openCreate = () => {
    setMode("create");
    setForm({
      employee_id: nextEmployeeId(),
      name: "",
      reference: "",
      company: "",
      location: "",
      position: "",
      phone: "",
      labor_rate: "",
      per_diem: "",
      timesheet_name: "",
      quickbooks_name: "",
    });
    setError(null);
    setOpen(true);
  };

  const saveDialog = async () => {
    setSaving(true);
    try {
      const payload: Partial<Employee> = { ...form };
      if (!payload.employee_id || !payload.name) {
        throw new Error("Employee ID and Name are required");
      }
      if (payload.labor_rate !== undefined)
        payload.labor_rate = payload.labor_rate === "" ? null : Number(payload.labor_rate);
      if (payload.per_diem !== undefined)
        payload.per_diem = payload.per_diem === "" ? null : Number(payload.per_diem);

      if (mode === "create") {
        const res = await fetch(`${API}/employees`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
      } else {
        const { employee_id, ...rest } = payload;
        const res = await fetch(`${API}/employees/${encodeURIComponent(employee_id!)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rest),
        });
        if (!res.ok) throw new Error(await res.text());
      }

      setOpen(false);
      await fetchRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // -------------- upload timesheet --------------
  const triggerUpload = () => fileInputRef.current?.click();
  const onUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${API}/timesheet/parse`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      if (Array.isArray(data.matched)) {
        setHours((prev) => {
          const copy = { ...prev };
          data.matched.forEach((m: { employee_id: string; week1_hours: number }) => {
            copy[m.employee_id] = { ...(copy[m.employee_id] || {}), w1: m.week1_hours };
          });
          return copy;
        });
      }

      if (data.unmatched_csv) {
        const blob = new Blob([data.unmatched_csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "unmatched.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      alert("Upload failed: " + (err as Error).message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // -------------- CSV export --------------
  const saveAsCSV = () => {
    const items = rows.map((r) => {
      const h = hours[r.employee_id] || {};
      const h1 = asNum(h.w1) ?? 0;
      const h2 = asNum(h.w2) ?? 0;
      const pdDays = asNum(h.pd) ?? 0;
      const wages = wagesFor(r, h1, h2);
      const perDiem = perDiemTotalFor(r, pdDays);
      const total = wages + perDiem;
      return {
        employee_id: r.employee_id,
        name: r.name ?? "",
        quickbooks_name: r.quickbooks_name ?? "",
        timesheet_name: r.timesheet_name ?? "",
        company: r.company ?? "",
        location: r.location ?? "",
        position: r.position ?? "",
        labor_rate: asNum(r.labor_rate) ?? 0,
        per_diem_rate: asNum(r.per_diem) ?? 0,
        week1_hours: h1,
        week2_hours: h2,
        per_diem_days: pdDays,
        wages,
        per_diem_total: perDiem,
        grand_total: total,
      };
    });

    const headers = Object.keys(items[0] || {});
    const csvLines = [
      headers.join(","),
      ...items.map((row) =>
        headers
          .map((h) => {
            const v = (row as Record<string, unknown>)[h];
            const s = v == null ? "" : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      ),
    ];
    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "payroll.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // -------------- columns --------------
  const columns: GridColDef<Employee>[] = [
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "quickbooks_name", headerName: "QB Name", minWidth: 160 },
    { field: "timesheet_name", headerName: "Timesheet Name", minWidth: 160 },
    { field: "reference", headerName: "Ref", minWidth: 100 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    {
      field: "labor_rate",
      headerName: "Rate",
      minWidth: 90,
      valueGetter: (p) => (asNum((p as any).row?.labor_rate) ?? 0),
      valueFormatter: (p: any) => money(Number(p?.value ?? 0)),
    },
    {
      field: "w1",
      headerName: "Week 1",
      minWidth: 110,
      sortable: false,
      filterable: false,
      renderCell: (p: GridRenderCellParams<Employee>) => {
        const id = p.row.employee_id;
        const value = hours[id]?.w1 ?? "";
        return (
          <TextField
            size="small"
            type="number"
            value={value}
            onChange={(e) => handleHoursChange(id, "w1", e.target.value)}
            sx={{ width: 100 }}
            inputProps={{ step: "0.25" }}
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
      renderCell: (p: GridRenderCellParams<Employee>) => {
        const id = p.row.employee_id;
        const value = hours[id]?.w2 ?? "";
        return (
          <TextField
            size="small"
            type="number"
            value={value}
            onChange={(e) => handleHoursChange(id, "w2", e.target.value)}
            sx={{ width: 100 }}
            inputProps={{ step: "0.25" }}
          />
        );
      },
    },
    {
      field: "per_diem",
      headerName: "Per Diem Rate",
      minWidth: 130,
      valueGetter: (p) => (asNum((p as any).row?.per_diem) ?? 0),
      valueFormatter: (p: any) => money(Number(p?.value ?? 0)),
    },
    {
      field: "per_diem_days",
      headerName: "PD Days",
      minWidth: 100,
      sortable: false,
      filterable: false,
      renderCell: (p: GridRenderCellParams<Employee>) => {
        const id = p.row.employee_id;
        const value = hours[id]?.pd ?? "";
        return (
          <TextField
            size="small"
            type="number"
            value={value}
            onChange={(e) => handlePerDiemDaysChange(id, e.target.value)}
            sx={{ width: 90 }}
          />
        );
      },
    },
    {
      field: "wages_total",
      headerName: "Wages",
      minWidth: 120,
      filterable: false,
      sortable: false,
      valueGetter: (p) => {
        const id = (p as any).row.employee_id as string;
        const h = hours[id] || {};
        return wagesFor((p as any).row as Employee, h.w1, h.w2);
      },
      valueFormatter: (p: any) => money(Number(p?.value ?? 0)),
    },
    {
      field: "per_diem_total",
      headerName: "Per Diem",
      minWidth: 120,
      filterable: false,
      sortable: false,
      valueGetter: (p) => {
        const id = (p as any).row.employee_id as string;
        const h = hours[id] || {};
        return perDiemTotalFor((p as any).row as Employee, h.pd);
      },
      valueFormatter: (p: any) => money(Number(p?.value ?? 0)),
    },
    {
      field: "grand_total",
      headerName: "Total",
      minWidth: 140,
      filterable: false,
      sortable: false,
      valueGetter: (p) => {
        const id = (p as any).row.employee_id as string;
        const h = hours[id] || {};
        return grandTotalFor((p as any).row as Employee, h.w1, h.w2, h.pd);
      },
      valueFormatter: (p: any) => money(Number(p?.value ?? 0)),
    },
    {
      field: "actions",
      headerName: "Edit",
      width: 80,
      sortable: false,
      filterable: false,
      renderCell: (p: GridRenderCellParams<Employee>) => (
        <IconButton size="small" onClick={() => openEdit(p.row)} aria-label="edit">
          <EditIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  // -------------- render --------------
  return (
    <Stack gap={2}>
      {/* Header & Actions */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={700}>
          Payroll
        </Typography>
        <Stack direction="row" gap={1}>
          <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={triggerUpload}>
            Upload Timesheet
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            accept=".xls,.xlsx,.csv"
            onChange={onUploadFile}
          />
          <Button variant="outlined" onClick={openCreate}>
            Add Employee
          </Button>
          <Button startIcon={<SaveAltIcon />} variant="contained" onClick={saveAsCSV}>
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
          label="Search by name / QB / timesheet"
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
          <Select label="Company" value={company} onChange={(e) => setCompany(e.target.value as string)}>
            {companies.map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" disabled={scope === "all"}>
          <InputLabel>Location</InputLabel>
          <Select label="Location" value={location} onChange={(e) => setLocation(e.target.value as string)}>
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

      {/* Edit/Create dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
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
              label="Per Diem"
              type="number"
              value={form.per_diem ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, per_diem: e.target.value }))}
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
          <Button onClick={saveDialog} variant="contained" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

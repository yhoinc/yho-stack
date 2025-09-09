"use client";
import * as React from "react";
import {
  Box, Button, Stack, TextField, Typography, Tabs, Tab
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";

type CompanyRow = {
  company: string;
  hours: number;
  wages: number;
  per_diem: number;
  grand_total: number;
};

type EmpRow = {
  employee_id: string;
  name: string;
  company: string;
  location: string;
  hours: number;
  wages: number;
  per_diem: number;
  grand_total: number;
};

type RunRow = {
  run_id: number;
  run_key: string;
  created_at: string;
  scope?: string | null;
  company?: string | null;
  location?: string | null;
  total_commission?: number | null;
  source_hours?: number | null;
  per_hour_rate?: number | null;
};

export default function ReportsPage() {
  const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  const [from, setFrom] = React.useState<string>("");
  const [to, setTo] = React.useState<string>("");
  const [tab, setTab] = React.useState(0);

  const [byCompany, setByCompany] = React.useState<CompanyRow[]>([]);
  const [byEmployee, setByEmployee] = React.useState<EmpRow[]>([]);
  const [runs, setRuns] = React.useState<RunRow[]>([]);
  const [commission, setCommission] = React.useState<{ total_commission: number; hours: number; per_hour_rate: number } | null>(null);
  const [loading, setLoading] = React.useState(false);

  const fetchAll = React.useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (from) q.set("date_from", from);
      if (to) q.set("date_to", to);

      const s = await fetch(`${API}/reports/summary?${q.toString()}`);
      const sd = await s.json();
      setByCompany(sd.by_company ?? []);
      setByEmployee(sd.by_employee ?? []);
      setCommission(sd.commission ?? null);

      const r = await fetch(`${API}/reports/runs`);
      const rd = await r.json();
      setRuns(rd.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [API, from, to]);

  React.useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const money = (n: unknown) => `$${Number(n || 0).toFixed(2)}`;

  // --- Columns (loosen formatter param typing to avoid 'never') ---
  const colsCompany: GridColDef[] = [
    { field: "company", headerName: "Company", flex: 1, minWidth: 180 },
    { field: "hours", headerName: "Hours", minWidth: 110, valueFormatter: (p: any) => Number(p.value || 0).toFixed(2) },
    { field: "wages", headerName: "Wages", minWidth: 120, valueFormatter: (p: any) => money(p.value) },
    { field: "per_diem", headerName: "Per Diem", minWidth: 120, valueFormatter: (p: any) => money(p.value) },
    { field: "grand_total", headerName: "Total Out", minWidth: 140, valueFormatter: (p: any) => money(p.value) },
  ];

  const colsEmp: GridColDef[] = [
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 200 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "hours", headerName: "Hours", minWidth: 110, valueFormatter: (p: any) => Number(p.value || 0).toFixed(2) },
    { field: "wages", headerName: "Wages", minWidth: 120, valueFormatter: (p: any) => money(p.value) },
    { field: "per_diem", headerName: "Per Diem", minWidth: 120, valueFormatter: (p: any) => money(p.value) },
    { field: "grand_total", headerName: "Total Out", minWidth: 140, valueFormatter: (p: any) => money(p.value) },
  ];

  const colsRuns: GridColDef[] = [
    { field: "run_key", headerName: "Run", flex: 1, minWidth: 180 },
    { field: "created_at", headerName: "Created", minWidth: 160 },
    { field: "scope", headerName: "Scope", minWidth: 100 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "source_hours", headerName: "Hours", minWidth: 110, valueFormatter: (p: any) => Number(p.value || 0).toFixed(2) },
    { field: "per_hour_rate", headerName: "Comm $/hr", minWidth: 110, valueFormatter: (p: any) => money(p.value) },
    { field: "total_commission", headerName: "Commission", minWidth: 140, valueFormatter: (p: any) => money(p.value) },
  ];

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={700}>Reports</Typography>
      </Stack>

      <Box
        sx={{
          p: 2, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 2,
          display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr auto" }, gap: 2
        }}
      >
        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          size="small"
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          size="small"
          InputLabelProps={{ shrink: true }}
        />
        <Button variant="contained" onClick={fetchAll} disabled={loading}>
          Apply
        </Button>
      </Box>

      {commission && (
        <Box sx={{ p: 2, border: "1px dashed #e5e7eb", borderRadius: 2 }}>
          <Typography variant="body1">
            <b>Commission (danny):</b> {money(commission.total_commission)} &nbsp;|&nbsp; Hours:{" "}
            {Number((commission as any).hours || 0).toFixed(2)} &nbsp;|&nbsp; Rate: {money((commission as any).per_hour_rate)}
          </Typography>
        </Box>
      )}

      <Tabs value={tab} onChange={(_, v) => setTab(v)}>
        <Tab label="By Company" />
        <Tab label="By Employee" />
        <Tab label="Runs" />
      </Tabs>

      {tab === 0 && (
        <Box sx={{ height: 520, bgcolor: "background.paper", borderRadius: 2 }}>
          <DataGrid
            rows={byCompany}
            columns={colsCompany}
            getRowId={(r) => r.company}
            loading={loading}
            pageSizeOptions={[10, 25, 50, 100]}
            initialState={{ pagination: { paginationModel: { pageSize: 25, page: 0 } } }}
            sx={{ "& .MuiDataGrid-columnHeaders": { background: "#f3f4f6", fontWeight: 600 } }}
          />
        </Box>
      )}

      {tab === 1 && (
        <Box sx={{ height: 520, bgcolor: "background.paper", borderRadius: 2 }}>
          <DataGrid
            rows={byEmployee}
            columns={colsEmp}
            getRowId={(r) => `${r.employee_id}-${r.company}`}
            loading={loading}
            pageSizeOptions={[10, 25, 50, 100]}
            initialState={{ pagination: { paginationModel: { pageSize: 25, page: 0 } } }}
            sx={{ "& .MuiDataGrid-columnHeaders": { background: "#f3f4f6", fontWeight: 600 } }}
          />
        </Box>
      )}

      {tab === 2 && (
        <Box sx={{ height: 520, bgcolor: "background.paper", borderRadius: 2 }}>
          <DataGrid
            rows={runs}
            columns={colsRuns}
            getRowId={(r) => r.run_id}
            loading={loading}
            pageSizeOptions={[10, 25, 50, 100]}
            initialState={{ pagination: { paginationModel: { pageSize: 25, page: 0 } } }}
            sx={{ "& .MuiDataGrid-columnHeaders": { background: "#f3f4f6", fontWeight: 600 } }}
          />
        </Box>
      )}
    </Stack>
  );
}

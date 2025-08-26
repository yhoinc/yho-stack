"use client";

import * as React from "react";
import {
  Box,
  Stack,
  TextField,
  MenuItem,
  Button,
  Typography,
  Alert,
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";

const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE as string | undefined) ?? "/api";

type RowAny = Record<string, any>;

async function fetchJSON(path: string) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }
  return res.json();
}

export default function ReportsPage() {
  // filters
  const [dateFrom, setDateFrom] = React.useState<string>("");
  const [dateTo, setDateTo] = React.useState<string>("");
  const [companyFilter, setCompanyFilter] = React.useState<string>("");

  // data + states
  const [payoutByCompany, setPayoutByCompany] = React.useState<RowAny[]>([]);
  const [payoutByEmployee, setPayoutByEmployee] = React.useState<RowAny[]>([]);
  const [hoursByEmployee, setHoursByEmployee] = React.useState<RowAny[]>([]);
  const [commissions, setCommissions] = React.useState<RowAny[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string>("");

  // load companies for the filter (optional – derived from payoutByCompany)
  const companies = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of payoutByCompany) {
      if (r.company) set.add(r.company);
    }
    return Array.from(set).sort();
  }, [payoutByCompany]);

  const buildQS = (params: Record<string, string | null | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") q.set(k, v);
    }
    const s = q.toString();
    return s ? `?${s}` : "";
    };

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const qs = buildQS({ date_from: dateFrom, date_to: dateTo });
      const qsEmp = buildQS({
        date_from: dateFrom,
        date_to: dateTo,
        company: companyFilter || undefined,
      });

      // parallel fetches
      const [pbc, pbe, hbe, com] = await Promise.all([
        fetchJSON(`/payroll/summary/payout_by_company${qs}`),
        fetchJSON(`/payroll/summary/payout_by_employee${qsEmp}`),
        fetchJSON(`/payroll/summary/hours_by_employee${qsEmp}`),
        fetchJSON(`/payroll/summary/commissions${qs}`),
      ]);

      setPayoutByCompany((pbc?.rows ?? []).map((r: RowAny, i: number) => ({ id: i, ...r })));
      setPayoutByEmployee((pbe?.rows ?? []).map((r: RowAny, i: number) => ({ id: i, ...r })));
      setHoursByEmployee((hbe?.rows ?? []).map((r: RowAny, i: number) => ({ id: i, ...r })));
      setCommissions((com?.rows ?? []).map((r: RowAny, i: number) => ({ id: i, ...r })));
    } catch (e: any) {
      console.error(e);
      setErr(String(e?.message ?? e));
      setPayoutByCompany([]);
      setPayoutByEmployee([]);
      setHoursByEmployee([]);
      setCommissions([]);
    } finally {
      setLoading(false);
    }
  }

  // initial load
  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // columns
  const colsPayoutByCompany: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 130, flex: 0.6 },
    { field: "company", headerName: "Company", minWidth: 160, flex: 0.8 },
    {
      field: "total_payout",
      headerName: "Total Payout",
      minWidth: 160,
      flex: 0.8,
      valueFormatter: (p) =>
        p.value == null ? "" : `$${Number(p.value).toFixed(2)}`,
    },
  ];

  const colsPayoutByEmployee: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 130, flex: 0.6 },
    { field: "company", headerName: "Company", minWidth: 140, flex: 0.7 },
    { field: "employee_id", headerName: "Emp ID", minWidth: 120, flex: 0.6 },
    { field: "name", headerName: "Name", minWidth: 200, flex: 1.1 },
    {
      field: "total_paid",
      headerName: "Total Paid",
      minWidth: 140,
      flex: 0.7,
      valueFormatter: (p) =>
        p.value == null ? "" : `$${Number(p.value).toFixed(2)}`,
    },
  ];

  const colsHoursByEmployee: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 130, flex: 0.6 },
    { field: "company", headerName: "Company", minWidth: 140, flex: 0.7 },
    { field: "employee_id", headerName: "Emp ID", minWidth: 120, flex: 0.6 },
    { field: "name", headerName: "Name", minWidth: 200, flex: 1.1 },
    {
      field: "total_hours",
      headerName: "Total Hours",
      minWidth: 140,
      flex: 0.7,
      valueFormatter: (p) =>
        p.value == null ? "" : Number(p.value).toFixed(2),
    },
  ];

  const colsCommissions: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 130, flex: 0.6 },
    { field: "beneficiary", headerName: "Beneficiary", minWidth: 160, flex: 0.8 },
    {
      field: "per_hour_rate",
      headerName: "Per-Hour Rate",
      minWidth: 150,
      flex: 0.7,
      valueFormatter: (p) =>
        p.value == null ? "" : `$${Number(p.value).toFixed(2)}`,
    },
    {
      field: "source_hours",
      headerName: "Source Hours",
      minWidth: 150,
      flex: 0.7,
      valueFormatter: (p) =>
        p.value == null ? "" : Number(p.value).toFixed(2),
    },
    {
      field: "total_commission",
      headerName: "Total Commission",
      minWidth: 170,
      flex: 0.8,
      valueFormatter: (p) =>
        p.value == null ? "" : `$${Number(p.value).toFixed(2)}`,
    },
  ];

  return (
    <Stack gap={2}>
      <Typography variant="h5" sx={{ fontWeight: 700 }}>
        Reports
      </Typography>

      {/* Filters */}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        gap={2}
        alignItems={{ xs: "stretch", sm: "center" }}
      >
        <TextField
          label="From (UTC)"
          type="date"
          size="small"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          label="To (UTC)"
          type="date"
          size="small"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          label="Company (optional)"
          select
          size="small"
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="">All Companies</MenuItem>
          {companies.map((c) => (
            <MenuItem key={c} value={c}>
              {c}
            </MenuItem>
          ))}
        </TextField>
        <Button variant="contained" onClick={load}>
          Reload
        </Button>
      </Stack>

      {err && <Alert severity="error">{err}</Alert>}

      {/* Layout: 2x2 grids, responsive */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
          gap: 2,
        }}
      >
        <Box sx={{ height: 420, width: "100%" }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
            Payout by Company
          </Typography>
          <DataGrid
            rows={payoutByCompany}
            columns={colsPayoutByCompany}
            loading={loading}
            disableRowSelectionOnClick
            initialState={{
              sorting: { sortModel: [{ field: "run_date", sort: "desc" }] },
              pagination: { paginationModel: { pageSize: 25, page: 0 } },
            }}
            pageSizeOptions={[10, 25, 50]}
          />
        </Box>

        <Box sx={{ height: 420, width: "100%" }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
            Payout by Employee{companyFilter ? ` — ${companyFilter}` : ""}
          </Typography>
          <DataGrid
            rows={payoutByEmployee}
            columns={colsPayoutByEmployee}
            loading={loading}
            disableRowSelectionOnClick
            initialState={{
              sorting: { sortModel: [{ field: "run_date", sort: "desc" }] },
              pagination: { paginationModel: { pageSize: 25, page: 0 } },
            }}
            pageSizeOptions={[10, 25, 50]}
          />
        </Box>

        <Box sx={{ height: 420, width: "100%" }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
            Hours by Employee{companyFilter ? ` — ${companyFilter}` : ""}
          </Typography>
          <DataGrid
            rows={hoursByEmployee}
            columns={colsHoursByEmployee}
            loading={loading}
            disableRowSelectionOnClick
            initialState={{
              sorting: { sortModel: [{ field: "run_date", sort: "desc" }] },
              pagination: { paginationModel: { pageSize: 25, page: 0 } },
            }}
            pageSizeOptions={[10, 25, 50]}
          />
        </Box>

        <Box sx={{ height: 420, width: "100%" }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
            Commissions
          </Typography>
          <DataGrid
            rows={commissions}
            columns={colsCommissions}
            loading={loading}
            disableRowSelectionOnClick
            initialState={{
              sorting: { sortModel: [{ field: "run_date", sort: "desc" }] },
              pagination: { paginationModel: { pageSize: 25, page: 0 } },
            }}
            pageSizeOptions={[10, 25, 50]}
          />
        </Box>
      </Box>
    </Stack>
  );
}

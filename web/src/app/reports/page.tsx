"use client";
import * as React from "react";
import {
  Box,
  Button,
  Stack,
  TextField,
  Typography,
  Tabs,
  Tab,
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";

type HoursCompany = { company: string; run_date: string; total_hours: number };
type HoursEmployee = {
  employee_id: string;
  name: string;
  company: string;
  run_date: string;
  total_hours: number;
};
type PayoutCompany = { company: string; run_date: string; total_payout: number };
type PayoutEmployee = {
  employee_id: string;
  name: string;
  company: string;
  run_date: string;
  total_paid: number;
};
type CommissionRow = {
  beneficiary: string;
  run_date: string;
  per_hour_rate: number;
  source_hours: number;
  total_commission: number;
};

export default function ReportsPage() {
  const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [tab, setTab] = React.useState(0);
  const [loading, setLoading] = React.useState(false);

  // Data sets
  const [hoursByCompany, setHoursByCompany] = React.useState<HoursCompany[]>(
    []
  );
  const [hoursByEmployee, setHoursByEmployee] = React.useState<HoursEmployee[]>(
    []
  );
  const [payoutByCompany, setPayoutByCompany] = React.useState<PayoutCompany[]>(
    []
  );
  const [payoutByEmployee, setPayoutByEmployee] = React.useState<
    PayoutEmployee[]
  >([]);
  const [commissions, setCommissions] = React.useState<CommissionRow[]>([]);

  const qs = () => {
    const q = new URLSearchParams();
    if (dateFrom) q.set("date_from", dateFrom);
    if (dateTo) q.set("date_to", dateTo);
    return q.toString();
  };

  const fetchJSON = async <T,>(url: string): Promise<T> => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };

  const money = (v: unknown) => `$${Number(v || 0).toFixed(2)}`;
  const hoursFmt = (v: unknown) => Number(v || 0).toFixed(2);

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    try {
      const query = qs();

      const [
        hco,
        hem,
        pco,
        pem,
        com,
      ] = await Promise.all([
        fetchJSON<{ rows: HoursCompany[] }>(
          `${API}/payroll/summary/hours_by_company?${query}`
        ),
        fetchJSON<{ rows: HoursEmployee[] }>(
          `${API}/payroll/summary/hours_by_employee?${query}`
        ),
        fetchJSON<{ rows: PayoutCompany[] }>(
          `${API}/payroll/summary/payout_by_company?${query}`
        ),
        fetchJSON<{ rows: PayoutEmployee[] }>(
          `${API}/payroll/summary/payout_by_employee?${query}`
        ),
        fetchJSON<{ rows: CommissionRow[] }>(
          `${API}/payroll/summary/commissions?${query}`
        ),
      ]);

      setHoursByCompany(hco.rows ?? []);
      setHoursByEmployee(hem.rows ?? []);
      setPayoutByCompany(pco.rows ?? []);
      setPayoutByEmployee(pem.rows ?? []);
      setCommissions(com.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [API, dateFrom, dateTo]);

  React.useEffect(() => {
    // initial load
    loadAll();
  }, [loadAll]);

  // CSV helpers
  function downloadCSV<T extends object>(rows: T[], filename: string) {
    if (!rows?.length) {
      alert("No data to download.");
      return;
    }
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(","),
      ...rows.map((r) =>
        headers
          .map((h) => {
            const raw = (r as any)[h];
            const s = raw == null ? "" : String(raw);
            // naive CSV escaping
            if (s.includes(",") || s.includes('"') || s.includes("\n")) {
              return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
          })
          .join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Columns (loosen formatter param typing to avoid TS 'never' issues)
  const colsHoursByCompany: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 120 },
    { field: "company", headerName: "Company", flex: 1, minWidth: 180 },
    {
      field: "total_hours",
      headerName: "Hours",
      minWidth: 110,
      valueFormatter: (p: any) => hoursFmt(p.value),
    },
  ];

  const colsHoursByEmployee: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 120 },
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 200 },
    { field: "company", headerName: "Company", minWidth: 140 },
    {
      field: "total_hours",
      headerName: "Hours",
      minWidth: 110,
      valueFormatter: (p: any) => hoursFmt(p.value),
    },
  ];

  const colsPayoutByCompany: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 120 },
    { field: "company", headerName: "Company", flex: 1, minWidth: 180 },
    {
      field: "total_payout",
      headerName: "Money Out",
      minWidth: 140,
      valueFormatter: (p: any) => money(p.value),
    },
  ];

  const colsPayoutByEmployee: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 120 },
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 200 },
    { field: "company", headerName: "Company", minWidth: 140 },
    {
      field: "total_paid",
      headerName: "Money Out",
      minWidth: 140,
      valueFormatter: (p: any) => money(p.value),
    },
  ];

  const colsCommission: GridColDef[] = [
    { field: "run_date", headerName: "Run Date", minWidth: 120 },
    { field: "beneficiary", headerName: "Beneficiary", minWidth: 140 },
    {
      field: "per_hour_rate",
      headerName: "Rate ($/hr)",
      minWidth: 120,
      valueFormatter: (p: any) => money(p.value),
    },
    {
      field: "source_hours",
      headerName: "Hours",
      minWidth: 110,
      valueFormatter: (p: any) => hoursFmt(p.value),
    },
    {
      field: "total_commission",
      headerName: "Commission",
      minWidth: 140,
      valueFormatter: (p: any) => money(p.value),
    },
  ];

  // Per-tab data & CSV hooks
  const current = [
    {
      rows: hoursByCompany,
      id: (r: HoursCompany) => `${r.run_date}-${r.company}`,
      columns: colsHoursByCompany,
      csv: () => downloadCSV(hoursByCompany, "hours_by_company.csv"),
    },
    {
      rows: hoursByEmployee,
      id: (r: HoursEmployee) => `${r.run_date}-${r.employee_id}-${r.company}`,
      columns: colsHoursByEmployee,
      csv: () => downloadCSV(hoursByEmployee, "hours_by_employee.csv"),
    },
    {
      rows: payoutByCompany,
      id: (r: PayoutCompany) => `${r.run_date}-${r.company}`,
      columns: colsPayoutByCompany,
      csv: () => downloadCSV(payoutByCompany, "money_out_by_company.csv"),
    },
    {
      rows: payoutByEmployee,
      id: (r: PayoutEmployee) => `${r.run_date}-${r.employee_id}-${r.company}`,
      columns: colsPayoutByEmployee,
      csv: () => downloadCSV(payoutByEmployee, "money_out_by_employee.csv"),
    },
    {
      rows: commissions,
      id: (r: CommissionRow, idx: number) => `${r.run_date}-${r.beneficiary}-${idx}`,
      columns: colsCommission,
      csv: () => downloadCSV(commissions, "commission.csv"),
    },
  ][tab];

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={700}>
          Reports
        </Typography>
      </Stack>

      {/* Date Filters */}
      <Box
        sx={{
          p: 2,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 2,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr auto auto" },
          gap: 2,
        }}
      >
        <TextField
          label="From"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          size="small"
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          label="To"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          size="small"
          InputLabelProps={{ shrink: true }}
        />
        <Button variant="contained" onClick={loadAll} disabled={loading}>
          Apply
        </Button>
        <Button variant="outlined" onClick={current.csv} disabled={!current.rows.length}>
          Download CSV
        </Button>
      </Box>

      {/* Tabs */}
      <Tabs value={tab} onChange={(_, v) => setTab(v)}>
        <Tab label="Hours by Company" />
        <Tab label="Hours by Employee" />
        <Tab label="Money Out by Company" />
        <Tab label="Money Out by Employee" />
        <Tab label="Commission" />
      </Tabs>

      {/* Grid */}
      <Box sx={{ height: 560, bgcolor: "background.paper", borderRadius: 2 }}>
        <DataGrid
          rows={current.rows}
          columns={current.columns}
          getRowId={(r: any, idx?: number) => current.id(r, idx ?? 0)}
          loading={loading}
          pageSizeOptions={[10, 25, 50, 100]}
          initialState={{
            pagination: { paginationModel: { pageSize: 25, page: 0 } },
          }}
          sx={{
            "& .MuiDataGrid-columnHeaders": { background: "#f3f4f6", fontWeight: 600 },
          }}
        />
      </Box>
    </Stack>
  );
}

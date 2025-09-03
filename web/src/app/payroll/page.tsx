"use client";

import * as React from "react";
import {
  Box,
  Button,
  Stack,
  Typography,
} from "@mui/material";
import {
  DataGrid,
  GridColDef,
  GridRenderCellParams,
} from "@mui/x-data-grid";

type EmployeeRow = {
  employee_id: string;
  name: string;
  reference?: string | null;
  company?: string | null;
  location?: string | null;
  position?: string | null;
  phone?: string | null;
  labor_rate?: number | string | null;
  per_diem?: number | string | null;
  week1?: number;
  week2?: number;
};

export default function PayrollPage() {
  const API_BASE_RAW = process.env.NEXT_PUBLIC_API_BASE || "";
  const API = API_BASE_RAW.replace(/\/$/, ""); // trim trailing slash

  const [rows, setRows] = React.useState<EmployeeRow[]>([]);
  const [loading, setLoading] = React.useState(false);

  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/employees?limit=1000`);
      const d = await r.json();
      const raw: any[] = d?.rows ?? [];
      const withWeeks: EmployeeRow[] = raw.map((row) => ({
        ...row,
        week1: 0,
        week2: 0,
      }));
      setRows(withWeeks);
    } catch (err) {
      console.error("Could not load employees", err);
    } finally {
      setLoading(false);
    }
  }, [API]);

  React.useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const moneyFmt = (v: unknown) =>
    v == null || v === "" || Number.isNaN(Number(v)) ? "-" : `$${Number(v).toFixed(2)}`;

  const columns: GridColDef<EmployeeRow>[] = [
    { field: "employee_id", headerName: "ID", width: 90 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 160 },
    { field: "reference", headerName: "Ref", width: 120 },
    { field: "company", headerName: "Company", width: 150 },
    { field: "location", headerName: "Location", width: 150 },
    { field: "position", headerName: "Position", width: 150 },
    {
      field: "labor_rate",
      headerName: "Rate",
      width: 120,
      renderCell: (params: GridRenderCellParams<EmployeeRow, EmployeeRow["labor_rate"]>) =>
        moneyFmt(params.row?.labor_rate),
    },
    {
      field: "week1",
      headerName: "Week 1",
      width: 120,
      editable: true,
      type: "number",
      valueSetter: (v) => {
        // ensure numeric in state
        const val = Number(v.value ?? 0);
        return { ...v.row, week1: Number.isNaN(val) ? 0 : val };
      },
    },
    {
      field: "week2",
      headerName: "Week 2",
      width: 120,
      editable: true,
      type: "number",
      valueSetter: (v) => {
        const val = Number(v.value ?? 0);
        return { ...v.row, week2: Number.isNaN(val) ? 0 : val };
      },
    },
    {
      field: "check",
      headerName: "Check",
      width: 150,
      sortable: false,
      filterable: false,
      renderCell: (params: GridRenderCellParams<EmployeeRow>) => {
        const rate = Number(params.row?.labor_rate ?? 0);
        const w1 = Number(params.row?.week1 ?? 0);
        const w2 = Number(params.row?.week2 ?? 0);
        const total = (w1 + w2) * (Number.isNaN(rate) ? 0 : rate);
        return `$${total.toFixed(2)}`;
      },
    },
  ];

  function handleExportCSV() {
    const eligible = rows.filter(
      (r) => (Number(r.week1) || 0) > 0 || (Number(r.week2) || 0) > 0
    );

    if (eligible.length === 0) {
      alert("No rows with hours to export.");
      return;
    }

    // gather headers across all rows to include everything currently present
    const headers = Array.from(
      eligible.reduce((set: Set<string>, row) => {
        Object.keys(row).forEach((k) => set.add(k));
        return set;
      }, new Set<string>())
    );

    const esc = (val: unknown) => {
      const s = val == null ? "" : String(val);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines: string[] = [];
    lines.push(headers.join(",")); // header row
    for (const row of eligible) {
      lines.push(headers.map((h) => esc((row as any)[h])).join(","));
    }

    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `payroll_${date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={600}>
          Payroll
        </Typography>
        <Button variant="outlined" onClick={handleExportCSV}>
          Save as CSV
        </Button>
      </Stack>

      <Box
        sx={{
          height: 640,
          width: "100%",
          bgcolor: "background.paper",
          borderRadius: 2,
          p: 1,
        }}
      >
        <DataGrid<EmployeeRow>
          rows={rows}
          columns={columns}
          getRowId={(r) => r.employee_id}
          loading={loading}
          disableRowSelectionOnClick
          processRowUpdate={(newRow) => {
            setRows((prev) =>
              prev.map((row) =>
                row.employee_id === newRow.employee_id ? newRow : row
              )
            );
            return newRow;
          }}
        />
      </Box>
    </Stack>
  );
}

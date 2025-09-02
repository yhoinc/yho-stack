"use client";

import * as React from "react";
import {
  Box,
  Stack,
  Button,
  Typography,
  TextField,
} from "@mui/material";
import { DataGrid, GridColDef, GridToolbar } from "@mui/x-data-grid";
import DownloadIcon from "@mui/icons-material/Download";

// Adjust this type to match your backend shape if you want stricter typing.
// The index signature lets the grid & exporter include every column without "any".
type PayrollRow = {
  employee_id: string;
  name?: string | null;
  company?: string | null;
  location?: string | null;
  position?: string | null;
  labor_rate?: number | string | null;
  per_diem?: number | string | null;

  // Common hour fields (kept optional; we’ll detect them dynamically too)
  week1_hours?: number | string | null;
  week2_hours?: number | string | null;

  // Allow additional fields to pass-through/export
  [key: string]: unknown;
};

export default function PayrollPage(): JSX.Element {
  const API_BASE_RAW = process.env.NEXT_PUBLIC_API_BASE || "";
  const API = API_BASE_RAW.replace(/\/$/, ""); // trim trailing slash

  const [rows, setRows] = React.useState<PayrollRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [q, setQ] = React.useState("");

  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/payroll?limit=2000`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      const raw = (d?.rows ?? []) as PayrollRow[];
      setRows(raw);
    } catch (e) {
      console.error("Failed to load payroll rows:", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [API]);

  React.useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // --- Helpers --------------------------------------------------------------

  // Normalize a “maybe-number” value.
  const num = (v: unknown): number => {
    if (v == null || v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Some datasets name hours like "week1", "week1_hours", "wk1_hours", etc.
  // This tries a few sensible patterns and also scans keys if needed.
  const getWeekHours = (row: PayrollRow, week: 1 | 2): number => {
    const directKeys = [
      `week${week}_hours`,
      `week${week}hours`,
      `wk${week}_hours`,
      `wk${week}hours`,
      `week${week}`,
    ];

    for (const k of directKeys) {
      if (k in row) return num(row[k]);
    }

    // Fallback: scan for a key that includes week id + "hour" (case-insensitive).
    const needle = `week${week}`;
    const hoursKey = Object.keys(row).find(
      (k) => k.toLowerCase().includes(needle) && k.toLowerCase().includes("hour")
    );
    return hoursKey ? num(row[hoursKey]) : 0;
  };

  // Quick client-side search across a few stringy fields
  const lc = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
  const filtered = React.useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return rows;
    return rows.filter((r) => {
      return (
        lc(r.employee_id).includes(qq) ||
        lc(r.name).includes(qq) ||
        lc(r.company).includes(qq) ||
        lc(r.location).includes(qq) ||
        lc(r.position).includes(qq)
      );
    });
  }, [rows, q]);

  // Columns — adjust to your schema; the exporter will include *all* fields anyway.
  const columns: GridColDef[] = [
    { field: "employee_id", headerName: "ID", minWidth: 110 },
    { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
    { field: "company", headerName: "Company", minWidth: 140 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    {
      field: "labor_rate",
      headerName: "Labor Rate",
      minWidth: 120,
      valueFormatter: (p) => {
        const v = p?.value;
        return v == null || v === "" || Number.isNaN(Number(v))
          ? "-"
          : `$${Number(v).toFixed(2)}`;
      },
    },
    {
      field: "per_diem",
      headerName: "Per Diem",
      minWidth: 110,
      valueFormatter: (p) => {
        const v = p?.value;
        return v == null || v === "" || Number.isNaN(Number(v))
          ? "-"
          : `$${Number(v).toFixed(2)}`;
      },
    },
    {
      field: "week1_hours",
      headerName: "Week 1 Hrs",
      minWidth: 110,
      valueFormatter: (p) => {
        const v = p?.value;
        return v == null || v === "" || Number.isNaN(Number(v)) ? "0" : Number(v).toFixed(2);
      },
    },
    {
      field: "week2_hours",
      headerName: "Week 2 Hrs",
      minWidth: 110,
      valueFormatter: (p) => {
        const v = p?.value;
        return v == null || v === "" || Number.isNaN(Number(v)) ? "0" : Number(v).toFixed(2);
      },
    },
  ];

  // --- Export logic ---------------------------------------------------------

  const exportToExcel = async () => {
    try {
      // filter to rows with any hours in week 1 or week 2
      const withHours = rows.filter(
        (r) => getWeekHours(r, 1) > 0 || getWeekHours(r, 2) > 0
      );

      if (withHours.length === 0) {
        alert("No employees with hours in Week 1 or Week 2.");
        return;
      }

      // Dynamic import to keep bundle light
      const XLSX = await import("xlsx");

      // Convert to sheet; this captures *full row objects* as-is
      const ws = XLSX.utils.json_to_sheet(withHours);

      // Create workbook and append
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Payroll");

      // Filename with timestamp
      const pad = (n: number) => String(n).padStart(2, "0");
      const dt = new Date();
      const fname = `payroll-${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(
        dt.getDate()
      )}-${pad(dt.getHours())}${pad(dt.getMinutes())}.xlsx`;

      XLSX.writeFile(wb, fname);
    } catch (e) {
      console.error("Export failed:", e);
      alert("Export failed. See console for details.");
    }
  };

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" fontWeight={600}>
          Payroll
        </Typography>

        <Stack direction="row" gap={1} alignItems="center">
          <TextField
            size="small"
            placeholder="Search name, company, location, position…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            sx={{ width: 420 }}
          />
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={exportToExcel}
          >
            Export Excel
          </Button>
        </Stack>
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
        <DataGrid
          rows={filtered}
          columns={columns}
          getRowId={(r) => r.employee_id}
          loading={loading}
          disableRowSelectionOnClick
          slots={{ toolbar: GridToolbar }}
          initialState={{
            pagination: { paginationModel: { pageSize: 25, page: 0 } },
            sorting: { sortModel: [{ field: "name", sort: "asc" }] },
          }}
          pageSizeOptions={[10, 25, 50, 100]}
        />
      </Box>
    </Stack>
  );
}

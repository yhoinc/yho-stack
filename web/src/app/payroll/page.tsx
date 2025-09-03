"use client";

import * as React from "react";
import {
  Box,
  Button,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  DataGrid,
  GridColDef,
  GridCellEditStopParams,
  GridCellEditStopReasons,
  GridToolbar,
} from "@mui/x-data-grid";

type Employee = {
  employee_id: string;
  reference?: string | null;
  company?: string | null;
  location?: string | null;
  name?: string | null;
  position?: string | null;
  phone?: string | null;
  labor_rate?: number | string | null;
  per_diem?: number | string | null;

  // local-only fields for this page
  week1?: number;
  week2?: number;
};

export default function PayrollPage() {
  const API_BASE_RAW = process.env.NEXT_PUBLIC_API_BASE || "";
  // trim trailing slash if present
  const API = API_BASE_RAW.replace(/\/$/, "");

  const [rows, setRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const fetchRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/employees?limit=5000`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      const raw: Employee[] = d?.rows ?? [];

      // initialize week fields (keep prior hours if any already in state)
      setRows((prev) => {
        const prevMap = new Map(prev.map((p) => [p.employee_id, p]));
        return raw.map((e) => {
          const existing = prevMap.get(e.employee_id);
          return {
            ...e,
            week1: existing?.week1 ?? 0,
            week2: existing?.week2 ?? 0,
          };
        });
      });
    } catch (err) {
      console.error("Load payroll failed:", err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [API]);

  React.useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // Easy currency formatter
  const money = (n: number | string | null | undefined) => {
    const v = Number(n);
    if (!isFinite(v)) return "$0.00";
    return `$${v.toFixed(2)}`;
  };

  // Commit numeric edits for week1/week2
  const handleCellEditStop = React.useCallback(
    (params: GridCellEditStopParams, reason: GridCellEditStopReasons) => {
      if (reason !== GridCellEditStopReasons.enterKeyDown && reason !== GridCellEditStopReasons.cellFocusOut) {
        return;
      }
      const { id, field } = params;
      if (field !== "week1" && field !== "week2") return;

      const newValue = Number(params.value);
      setRows((prev) =>
        prev.map((r) =>
          r.employee_id === id
            ? {
                ...r,
                [field]: isFinite(newValue) ? newValue : 0,
              }
            : r
        )
      );
    },
    []
  );

  // Filter on a few common text fields
  const filtered = React.useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const hay = [
        r.name,
        r.reference,
        r.company,
        r.location,
        r.position,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search]);

  const columns: GridColDef[] = [
    { field: "reference", headerName: "Ref", minWidth: 110 },
    { field: "company", headerName: "Company", minWidth: 130 },
    { field: "location", headerName: "Location", minWidth: 120 },
    { field: "position", headerName: "Position", minWidth: 140 },
    {
      field: "labor_rate",
      headerName: "Rate",
      minWidth: 110,
      sortable: true,
      valueGetter: (p) => Number(p.row?.labor_rate ?? 0),
      valueFormatter: (p) => money(p.value as number),
    },
    {
      field: "week1",
      headerName: "Week 1",
      type: "number",
      minWidth: 110,
      editable: true,
      valueGetter: (p) => Number(p.row?.week1 ?? 0),
    },
    {
      field: "week2",
      headerName: "Week 2",
      type: "number",
      minWidth: 110,
      editable: true,
      valueGetter: (p) => Number(p.row?.week2 ?? 0),
    },
    {
      field: "check",
      headerName: "Check",
      minWidth: 130,
      sortable: false,
      valueGetter: (p) => {
        const rate = Number(p.row?.labor_rate ?? 0);
        const w1 = Number(p.row?.week1 ?? 0);
        const w2 = Number(p.row?.week2 ?? 0);
        return (w1 + w2) * rate;
      },
      valueFormatter: (p) => money(p.value as number),
    },
  ];

  // Export only rows with hours to CSV
  const exportCSV = React.useCallback(() => {
    const withHours = rows.filter((r) => (Number(r.week1) || 0) > 0 || (Number(r.week2) || 0) > 0);
    if (withHours.length === 0) {
      alert("No rows with hours to export.");
      return;
    }

    const headers = [
      "employee_id",
      "name",
      "reference",
      "company",
      "location",
      "position",
      "labor_rate",
      "week1",
      "week2",
      "check",
    ];

    const lines = [headers.join(",")];

    for (const r of withHours) {
      const rate = Number(r.labor_rate ?? 0);
      const w1 = Number(r.week1 ?? 0);
      const w2 = Number(r.week2 ?? 0);
      const check = (w1 + w2) * rate;

      const row = [
        r.employee_id ?? "",
        quote(r.name),
        quote(r.reference),
        quote(r.company),
        quote(r.location),
        quote(r.position),
        rate.toFixed(2),
        w1.toString(),
        w2.toString(),
        check.toFixed(2),
      ];
      lines.push(row.join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [rows]);

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Typography variant="h5" fontWeight={600}>
          Payroll
        </Typography>

        <Box sx={{ flex: 1 }} />

        <TextField
          placeholder="Search by name, ref, company, location, position..."
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 360 }}
        />

        <Button variant="contained" onClick={exportCSV}>
          Save as CSV
        </Button>
      </Stack>

      <Box sx={{ height: 680, width: "100%", bgcolor: "background.paper", borderRadius: 2, p: 1 }}>
        <DataGrid
          rows={filtered}
          columns={columns}
          getRowId={(r) => r.employee_id}
          loading={loading}
          disableRowSelectionOnClick
          editMode="cell"
          onCellEditStop={handleCellEditStop}
          slots={{ toolbar: GridToolbar }}
          initialState={{
            pagination: { paginationModel: { pageSize: 100, page: 0 } },
            sorting: { sortModel: [{ field: "company", sort: "asc" }] },
          }}
          pageSizeOptions={[25, 50, 100]}
        />
      </Box>
    </Stack>
  );
}

/** CSV-safe quoting */
function quote(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // quote if contains comma, quote, or newline
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

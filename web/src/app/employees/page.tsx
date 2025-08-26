"use client";

import * as React from "react";
import { Box, useMediaQuery } from "@mui/material";
import {
  DataGrid,
  GridColDef,
  GridRowsProp,
  GridToolbar,
} from "@mui/x-data-grid";

type Employee = {
  id: string;              // DataGrid key (mapped from employee_id)
  employee_id: string;
  name: string | null;
  company: string | null;
  location: string | null;
  reference: string | null;
  position: string | null;
  labor_rate: number | null;
  phone: string | null;
};

type EmployeesResponse = {
  rows: Omit<Employee, "id">[];
};

const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE as string | undefined) ?? "/api";

export default function EmployeesPage() {
  const [rows, setRows] = React.useState<GridRowsProp<Employee>>([]);
  const [loading, setLoading] = React.useState(true);
  const isSmall = useMediaQuery("(max-width: 640px)"); // used only for compact density

  const columns = React.useMemo<GridColDef<Employee>[]>(
    () => [
      { field: "employee_id", headerName: "ID", minWidth: 120, flex: 0.6 },
      { field: "name", headerName: "Name", minWidth: 200, flex: 1.4 },
      { field: "company", headerName: "Company", minWidth: 140, flex: 0.9 },
      { field: "location", headerName: "Location", minWidth: 120, flex: 0.8 },
      { field: "reference", headerName: "Reference", minWidth: 120, flex: 0.8 },
      {
        field: "labor_rate",
        headerName: "Labor Rate",
        type: "number",
        minWidth: 120,
        flex: 0.8,
        valueFormatter: (p) =>
          p.value != null ? `$${Number(p.value).toFixed(2)}` : "",
      },
      { field: "position", headerName: "Position", minWidth: 140, flex: 1 },
      { field: "phone", headerName: "Phone", minWidth: 140, flex: 0.9 },
    ],
    []
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE}/employees?limit=2000`, {
          cache: "no-store",
        });
        const data: EmployeesResponse = await res.json();
        if (cancelled) return;
        const mapped: Employee[] = (data.rows ?? []).map((r, i) => ({
          id: r.employee_id ?? String(i),
          ...r,
        }));
        setRows(mapped);
      } catch (e) {
        console.error("employees fetch failed:", e);
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box
      sx={{
        // Make the grid fill the available viewport area.
        height: "calc(100vh - 110px)", // adjust if your header height changes
        width: "100%",
        minWidth: 0, // <-- lets the grid shrink inside flex containers
      }}
    >
      <DataGrid
        rows={rows}
        columns={columns}
        loading={loading}
        disableRowSelectionOnClick
        density={isSmall ? "compact" : "standard"}
        // Keep ALL columns visible; let flex + minWidth handle sizing
        initialState={{
          pagination: { paginationModel: { pageSize: 25, page: 0 } },
          sorting: { sortModel: [{ field: "name", sort: "asc" }] },
          columns: { columnVisibilityModel: {} },
        }}
        pageSizeOptions={[10, 25, 50, 100]}
        slots={{ toolbar: GridToolbar }}
        slotProps={{
          toolbar: {
            showQuickFilter: true,
            quickFilterProps: { debounceMs: 200 },
          },
        }}
        sx={{
          "& .MuiDataGrid-columnHeaders": {
            position: "sticky",
            top: 0,
            zIndex: 1,
          },
          ".MuiDataGrid-main": { width: "100%" },
        }}
      />
    </Box>
  );
}

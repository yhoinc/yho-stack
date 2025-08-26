"use client";

import * as React from "react";
import {
  DataGrid,
  GridColDef,
  GridToolbar,
  GridRowsProp,
} from "@mui/x-data-grid";
import { Box, useMediaQuery } from "@mui/material";

type Employee = {
  id: string;               // for the grid (we map from employee_id)
  employee_id: string;
  name: string | null;
  company: string | null;
  location: string | null;
  reference: string | null;
  position: string | null;
  labor_rate: number | null;
  phone: string | null;
  address: string | null;
  deduction: string | null;
  debt: string | null;
  payment_count: string | null;
  apartment_id: string | null;
  per_diem: number | null;
};

type EmployeesResponse = {
  rows: Omit<Employee, "id">[];
};

const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE as string | undefined) ?? "/api";

export default function EmployeesPage() {
  const [rows, setRows] = React.useState<GridRowsProp<Employee>>([]);
  const [loading, setLoading] = React.useState(true);
  const isSmall = useMediaQuery("(max-width: 640px)"); // <sm

  const columns = React.useMemo<GridColDef<Employee>[]>(
    () => [
      { field: "employee_id", headerName: "ID", minWidth: 110, flex: 0.6 },
      { field: "name", headerName: "Name", minWidth: 180, flex: 1.3 },
      { field: "company", headerName: "Company", minWidth: 120, flex: 0.8 },
      { field: "location", headerName: "Location", minWidth: 110, flex: 0.7 },
      { field: "reference", headerName: "Ref", minWidth: 90, flex: 0.5 },
      {
        field: "labor_rate",
        headerName: "Rate",
        type: "number",
        minWidth: 100,
        flex: 0.6,
        valueFormatter: (params) =>
          params.value != null ? `$${Number(params.value).toFixed(2)}` : "",
      },
      { field: "position", headerName: "Position", minWidth: 120, flex: 0.9 },
      // You can add phone/address/etc. here as needed
    ],
    []
  );

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/employees?limit=1000`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: EmployeesResponse = await res.json();

        if (!cancelled) {
          const mapped: Employee[] = (data.rows ?? []).map((r, i) => ({
            id: r.employee_id ?? String(i),
            ...r,
          }));
          setRows(mapped);
        }
      } catch (err) {
        console.error("Failed to load employees:", err);
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box
      sx={{
        height: "calc(100vh - 110px)", // fills viewport under your header
        width: "100%",
      }}
    >
      <DataGrid
        rows={rows}
        columns={columns}
        loading={loading}
        disableRowSelectionOnClick
        // Responsive niceties
        density={isSmall ? "compact" : "standard"}
        initialState={{
          pagination: { paginationModel: { pageSize: 25, page: 0 } },
          columns: {
            // Hide less-critical columns on very small screens
            columnVisibilityModel: isSmall
              ? { reference: false, position: false, company: false, location: false }
              : {},
          },
          sorting: {
            sortModel: [{ field: "name", sort: "asc" }],
          },
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
          "& .MuiDataGrid-columnHeaders": { position: "sticky", top: 0, zIndex: 1 },
        }}
      />
    </Box>
  );
}

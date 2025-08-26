"use client";

import * as React from "react";
import {
  DataGrid,
  GridColDef,
  GridRowsProp,
  GridToolbar,
  GridRowModes,
  GridRowModesModel,
  GridActionsCellItem,
  GridRowModel,
} from "@mui/x-data-grid";
import { Box } from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import SaveIcon from "@mui/icons-material/Save";
import CloseIcon from "@mui/icons-material/Close";

type Employee = {
  id: string; // DataGrid key (mapped from employee_id)
  employee_id: string;
  name: string | null;
  company: string | null;
  location: string | null;
  reference: string | null;
  position: string | null;
  labor_rate: number | null;
  per_diem: number | null;
  phone: string | null;
};

type EmployeesResponse = { rows: Omit<Employee, "id">[] };

const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE as string | undefined) ?? "/api";

export default function EmployeesPage() {
  const [rows, setRows] = React.useState<GridRowsProp<Employee>>([]);
  const [loading, setLoading] = React.useState(true);
  const [rowModesModel, setRowModesModel] = React.useState<GridRowModesModel>(
    {}
  );

  // ---------- load ----------
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

  // ---------- editing helpers ----------
  const handleEditClick = (id: string) => () => {
    setRowModesModel((prev) => ({ ...prev, [id]: { mode: GridRowModes.Edit } }));
  };

  const handleSaveClick = (id: string) => () => {
    setRowModesModel((prev) => ({ ...prev, [id]: { mode: GridRowModes.View } }));
  };

  const handleCancelClick = (id: string) => () => {
    setRowModesModel((prev) => ({
      ...prev,
      [id]: { mode: GridRowModes.View, ignoreModifications: true },
    }));
  };

  async function processRowUpdate(newRow: GridRowModel, oldRow: GridRowModel) {
    // Build a PATCH object of changed editable fields
    const editableFields = [
      "name",
      "company",
      "location",
      "reference",
      "position",
      "labor_rate",
      "per_diem",
      "phone",
    ] as const;

    const payload: Record<string, unknown> = {};
    for (const key of editableFields) {
      if (newRow[key] !== oldRow[key]) {
        payload[key] = newRow[key];
      }
    }

    if (Object.keys(payload).length === 0) return newRow; // nothing to save

    try {
      const id = String(newRow.employee_id);
      const res = await fetch(`${API_BASE}/employees/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`PATCH ${id} -> ${res.status}`);
      }
      // Optimistically update local state
      setRows((prev) =>
        prev.map((r: any) => (r.id === newRow.id ? { ...r, ...newRow } : r))
      );
      return newRow;
    } catch (e) {
      console.error("save failed", e);
      // Revert to the old row if save fails
      return oldRow;
    }
  }

  // ---------- columns ----------
  const columns = React.useMemo<GridColDef<Employee>[]>(
    () => [
      { field: "employee_id", headerName: "ID", minWidth: 120, flex: 0.6 },
      {
        field: "name",
        headerName: "Name",
        minWidth: 200,
        flex: 1.4,
        editable: true,
      },
      {
        field: "company",
        headerName: "Company",
        minWidth: 140,
        flex: 0.9,
        editable: true,
      },
      {
        field: "location",
        headerName: "Location",
        minWidth: 120,
        flex: 0.8,
        editable: true,
      },
      {
        field: "reference",
        headerName: "Reference",
        minWidth: 120,
        flex: 0.8,
        editable: true,
      },
      {
        field: "labor_rate",
        headerName: "Labor Rate",
        type: "number",
        minWidth: 120,
        flex: 0.8,
        editable: true,
        valueFormatter: (p) =>
          p.value != null ? `$${Number(p.value).toFixed(2)}` : "",
      },
      {
        field: "per_diem",
        headerName: "Per Diem",
        type: "number",
        minWidth: 110,
        flex: 0.7,
        editable: true,
        valueFormatter: (p) =>
          p.value != null ? `$${Number(p.value).toFixed(2)}` : "",
      },
      {
        field: "position",
        headerName: "Position",
        minWidth: 140,
        flex: 1,
        editable: true,
      },
      {
        field: "phone",
        headerName: "Phone",
        minWidth: 140,
        flex: 0.9,
        editable: true,
      },
      {
        field: "actions",
        type: "actions",
        headerName: "Actions",
        minWidth: 120,
        getActions: (params) => {
          const id = String(params.id);
          const isEditing = rowModesModel[id]?.mode === GridRowModes.Edit;
          if (isEditing) {
            return [
              <GridActionsCellItem
                key="save"
                icon={<SaveIcon />}
                label="Save"
                onClick={handleSaveClick(id)}
              />,
              <GridActionsCellItem
                key="cancel"
                icon={<CloseIcon />}
                label="Cancel"
                onClick={handleCancelClick(id)}
                color="inherit"
              />,
            ];
          }
          return [
            <GridActionsCellItem
              key="edit"
              icon={<EditIcon />}
              label="Edit"
              onClick={handleEditClick(id)}
              color="inherit"
            />,
          ];
        },
      },
    ],
    [rowModesModel]
  );

  // ---------- render ----------
  return (
    <Box
      sx={{
        height: "calc(100vh - 110px)", // fill viewport under header
        width: "100%",
        minWidth: 0,
      }}
    >
      <DataGrid
        rows={rows}
        columns={columns}
        loading={loading}
        disableRowSelectionOnClick
        editMode="row"
        rowModesModel={rowModesModel}
        onRowModesModelChange={setRowModesModel}
        processRowUpdate={processRowUpdate}
        // search/sort/pagination defaults
        initialState={{
          pagination: { paginationModel: { pageSize: 25, page: 0 } },
          sorting: { sortModel: [{ field: "name", sort: "asc" }] },
        }}
        pageSizeOptions={[10, 25, 50, 100]}
        slots={{ toolbar: GridToolbar }}
        slotProps={{
          toolbar: { showQuickFilter: true, quickFilterProps: { debounceMs: 200 } },
        }}
        sx={{
          "& .MuiDataGrid-columnHeaders": { position: "sticky", top: 0, zIndex: 1 },
          ".MuiDataGrid-main": { width: "100%" },
        }}
      />
    </Box>
  );
}

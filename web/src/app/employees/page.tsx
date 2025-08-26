"use client";

import * as React from "react";
import {
  DataGrid,
  GridColDef,
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
  id: string; // DataGrid key (from employee_id)
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

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE as string | undefined) ?? "/api";

export default function EmployeesPage() {
  const [rows, setRows] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [rowModesModel, setRowModesModel] = React.useState<GridRowModesModel>({});

  // ---- load data ----
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE}/employees?limit=2000`, { cache: "no-store" });
        const data: EmployeesResponse = await res.json();
        if (cancelled) return;
        const mapped: Employee[] = (data?.rows ?? []).map((r, i) => ({
          id: r.employee_id ?? String(i),
          ...r,
        })) as Employee[];
        setRows(mapped);
      } catch (err) {
        console.error("employees fetch failed:", err);
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- editing helpers ----
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
    // Only send changed editable fields
    const editable: (keyof Employee)[] = [
      "name",
      "company",
      "location",
      "reference",
      "position",
      "labor_rate",
      "per_diem",
      "phone",
    ];
    const patch: Record<string, unknown> = {};
    for (const k of editable) {
      if (newRow[k] !== oldRow[k]) patch[k] = newRow[k];
    }
    if (Object.keys(patch).length === 0) return newRow;

    try {
      const employee_id = String(newRow.employee_id ?? oldRow.employee_id);
      const res = await fetch(`${API_BASE}/employees/${encodeURIComponent(employee_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
      // optimistic local update
      setRows((prev) => prev.map((r) => (r.id === newRow.id ? { ...(newRow as Employee) } : r)));
      return newRow;
    } catch (e) {
      console.error("save failed, reverting", e);
      return oldRow; // revert if API fails
    }
  }

  // ---- columns ----
  const currencyFmt = (v: unknown) =>
    v === null || v === undefined || v === "" ? "" : `$${Number(v).toFixed(2)}`;

  const columns: GridColDef[] = [
    { field: "employee_id", headerName: "ID", minWidth: 120, flex: 0.6 },
    { field: "name", headerName: "Name", minWidth: 200, flex: 1.4, editable: true },
    { field: "company", headerName: "Company", minWidth: 140, flex: 0.9, editable: true },
    { field: "location", headerName: "Location", minWidth: 120, flex: 0.8, editable: true },
    { field: "reference", headerName: "Reference", minWidth: 120, flex: 0.8, editable: true },
    {
      field: "labor_rate",
      headerName: "Labor Rate",
      type: "number",
      minWidth: 120,
      flex: 0.8,
      editable: true,
      valueFormatter: (p) => currencyFmt(p.value),
    },
    {
      field: "per_diem",
      headerName: "Per Diem",
      type: "number",
      minWidth: 110,
      flex: 0.7,
      editable: true,
      valueFormatter: (p) => currencyFmt(p.value),
    },
    { field: "position", headerName: "Position", minWidth: 140, flex: 1, editable: true },
    { field: "phone", headerName: "Phone", minWidth: 140, flex: 0.9, editable: true },
    {
      field: "actions",
      type: "actions",
      headerName: "Actions",
      minWidth: 120,
      getActions: (params) => {
        const id = String(params.id);
        const isEditing = rowModesModel[id]?.mode === GridRowModes.Edit;
        return isEditing
          ? [
              <GridActionsCellItem key="save" icon={<SaveIcon />} label="Save" onClick={handleSaveClick(id)} />,
              <GridActionsCellItem key="cancel" icon={<CloseIcon />} label="Cancel" onClick={handleCancelClick(id)} />,
            ]
          : [<GridActionsCellItem key="edit" icon={<EditIcon />} label="Edit" onClick={handleEditClick(id)} />];
      },
    },
  ];

  // ---- render ----
  return (
    <Box
      sx={{
        height: "calc(100vh - 110px)", // adjust if your header height changes
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
        experimentalFeatures={{ newEditingApi: true }}
        initialState={{
          pagination: { paginationModel: { pageSize: 25, page: 0 } },
          sorting: { sortModel: [{ field: "name", sort: "asc" }] },
        }}
        pageSizeOptions={[10, 25, 50, 100]}
        sx={{
          "& .MuiDataGrid-columnHeaders": { position: "sticky", top: 0, zIndex: 1 },
          ".MuiDataGrid-main": { width: "100%" },
        }}
      />
    </Box>
  );
}

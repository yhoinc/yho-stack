"use client";
import * as React from "react";
import {
    Box, Button, Stack, TextField, Typography, Tabs, Tab, MenuItem,
    Select, FormControl, InputLabel
} from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";
import * as XLSX from "xlsx";

// --- helpers ---
const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

type HoursByCompanyRow = { company: string | null; run_date: string; total_hours: number };
type HoursByEmployeeRow = { employee_id: string; name: string; company: string | null; run_date: string; total_hours: number };
type PayoutByCompanyRow = { company: string | null; run_date: string; total_payout: number };
type PayoutByEmployeeRow = { employee_id: string; name: string; company: string | null; run_date: string; total_paid: number };
type CommissionRow = { beneficiary: string; run_date: string; per_hour_rate: number; source_hours: number; total_commission: number };

function useFetchRows<T>(endpoint: string, params: Record<string, any>) {
    const [rows, setRows] = React.useState<T[]>([]);
    const [loading, setLoading] = React.useState(false);

    const fetchRows = React.useCallback(async () => {
        setLoading(true);
        try {
            const base = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000").replace(/\/+$/, "");
            const usp = new URLSearchParams();
            Object.entries(params).forEach(([k, v]) => {
                if (v !== undefined && v !== null && String(v).trim() !== "") usp.set(k, String(v));
            });
            const url = `${base}${endpoint}${usp.toString() ? `?${usp.toString()}` : ""}`;
            console.log("[reports] GET", url); // 👈 log the exact URL
            const r = await fetch(url);
            if (!r.ok) {
                const txt = await r.text();
                console.error("GET failed", endpoint, r.status, txt);
                alert(`API error: ${endpoint}\n${r.status}\n${txt}`);
                setRows([]);
                return;
            }
            const d = await r.json();
            setRows((d?.rows ?? []) as T[]);
        } catch (e: any) {
            console.error("Fetch error", endpoint, e);
            alert(`Network error fetching ${endpoint}:\n${e?.message || e}`);
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [endpoint, params]);

    React.useEffect(() => { fetchRows(); }, [fetchRows]);
    return { rows, loading, refetch: fetchRows, setRows };
}

function exportSheet(name: string, data: any[]) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, name);
    XLSX.writeFile(wb, `${name.toLowerCase().replace(/\s+/g, "_")}.xlsx`);
}

export default function ReportsPage() {
    const [tab, setTab] = React.useState(0);

    // Shared filters (ISO: YYYY-MM-DD). Leave blank for no bounds.
    const [dateFrom, setDateFrom] = React.useState<string>("");
    const [dateTo, setDateTo] = React.useState<string>("");

    // Company filter for employee-based summaries
    const [company, setCompany] = React.useState<string>("");

    // Commission filter
    const [beneficiary, setBeneficiary] = React.useState<string>("");

    // ---- Tab 0: Hours by company ----
    const hoursByCompany = useFetchRows<HoursByCompanyRow>(
        "/payroll/summary/hours_by_company",
        { date_from: dateFrom || undefined, date_to: dateTo || undefined }
    );
    const hoursByCompanyCols: GridColDef<HoursByCompanyRow>[] = [
        { field: "run_date", headerName: "Run Date", minWidth: 130 },
        { field: "company", headerName: "Company", minWidth: 160, flex: 1 },
        { field: "total_hours", headerName: "Total Hours", minWidth: 140, valueFormatter: (p) => (p.value ?? 0).toFixed(2) },
    ];

    // ---- Tab 1: Hours by employee ----
    const hoursByEmployee = useFetchRows<HoursByEmployeeRow>(
        "/payroll/summary/hours_by_employee",
        {
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            company: company || undefined,
        }
    );
    const hoursByEmployeeCols: GridColDef<HoursByEmployeeRow>[] = [
        { field: "run_date", headerName: "Run Date", minWidth: 130 },
        { field: "company", headerName: "Company", minWidth: 160 },
        { field: "employee_id", headerName: "Employee ID", minWidth: 140 },
        { field: "name", headerName: "Name", minWidth: 200, flex: 1 },
        { field: "total_hours", headerName: "Total Hours", minWidth: 140, valueFormatter: (p) => (p.value ?? 0).toFixed(2) },
    ];

    // ---- Tab 2: Payout by company ----
    const payoutByCompany = useFetchRows<PayoutByCompanyRow>(
        "/payroll/summary/payout_by_company",
        { date_from: dateFrom || undefined, date_to: dateTo || undefined }
    );
    const payoutByCompanyCols: GridColDef<PayoutByCompanyRow>[] = [
        { field: "run_date", headerName: "Run Date", minWidth: 130 },
        { field: "company", headerName: "Company", minWidth: 160, flex: 1 },
        { field: "total_payout", headerName: "Total Payout", minWidth: 160, valueFormatter: (p) => `$${(p.value ?? 0).toFixed(2)}` },
    ];

    // ---- Tab 3: Payout by employee ----
    const payoutByEmployee = useFetchRows<PayoutByEmployeeRow>(
        "/payroll/summary/payout_by_employee",
        {
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            company: company || undefined,
        }
    );
    const payoutByEmployeeCols: GridColDef<PayoutByEmployeeRow>[] = [
        { field: "run_date", headerName: "Run Date", minWidth: 130 },
        { field: "company", headerName: "Company", minWidth: 160 },
        { field: "employee_id", headerName: "Employee ID", minWidth: 140 },
        { field: "name", headerName: "Name", minWidth: 200, flex: 1 },
        { field: "total_paid", headerName: "Total Paid", minWidth: 140, valueFormatter: (p) => `$${(p.value ?? 0).toFixed(2)}` },
    ];

    // ---- Tab 4: Commissions ----
    const commissions = useFetchRows<CommissionRow>(
        "/payroll/summary/commissions",
        {
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            beneficiary: beneficiary || undefined,
        }
    );
    const commissionCols: GridColDef<CommissionRow>[] = [
        { field: "run_date", headerName: "Run Date", minWidth: 130 },
        { field: "beneficiary", headerName: "Beneficiary", minWidth: 160, flex: 1 },
        { field: "per_hour_rate", headerName: "$/Hour", minWidth: 120, valueFormatter: (p) => `$${(p.value ?? 0).toFixed(2)}` },
        { field: "source_hours", headerName: "Hours", minWidth: 120, valueFormatter: (p) => (p.value ?? 0).toFixed(2) },
        { field: "total_commission", headerName: "Commission", minWidth: 150, valueFormatter: (p) => `$${(p.value ?? 0).toFixed(2)}` },
    ];

    // --- derive company list for the filter (from hoursByCompany result) ---
    const companyOptions = React.useMemo(() => {
        const s = new Set<string>();
        hoursByCompany.rows.forEach(r => r.company && s.add(String(r.company)));
        hoursByEmployee.rows.forEach(r => r.company && s.add(String(r.company)));
        payoutByCompany.rows.forEach(r => r.company && s.add(String(r.company)));
        payoutByEmployee.rows.forEach(r => r.company && s.add(String(r.company)));
        return ["", ...Array.from(s).sort()];
    }, [hoursByCompany.rows, hoursByEmployee.rows, payoutByCompany.rows, payoutByEmployee.rows]);

    // --- Active table config based on tab ---
    const current = [
        {
            title: "Hours by Company",
            data: hoursByCompany.rows,
            loading: hoursByCompany.loading,
            refetch: hoursByCompany.refetch,
            columns: hoursByCompanyCols,
            exportName: "Hours by Company",
            getRowId: (r: HoursByCompanyRow, i: number) => `${r.run_date}-${r.company ?? "(none)"}-${i}`,
        },
        {
            title: "Hours by Employee",
            data: hoursByEmployee.rows,
            loading: hoursByEmployee.loading,
            refetch: hoursByEmployee.refetch,
            columns: hoursByEmployeeCols,
            exportName: "Hours by Employee",
            getRowId: (r: HoursByEmployeeRow) => `${r.run_date}-${r.employee_id}`,
        },
        {
            title: "Payout by Company",
            data: payoutByCompany.rows,
            loading: payoutByCompany.loading,
            refetch: payoutByCompany.refetch,
            columns: payoutByCompanyCols,
            exportName: "Payout by Company",
            getRowId: (r: PayoutByCompanyRow, i: number) => `${r.run_date}-${r.company ?? "(none)"}-${i}`,
        },
        {
            title: "Payout by Employee",
            data: payoutByEmployee.rows,
            loading: payoutByEmployee.loading,
            refetch: payoutByEmployee.refetch,
            columns: payoutByEmployeeCols,
            exportName: "Payout by Employee",
            getRowId: (r: PayoutByEmployeeRow) => `${r.run_date}-${r.employee_id}`,
        },
        {
            title: "Commissions",
            data: commissions.rows,
            loading: commissions.loading,
            refetch: commissions.refetch,
            columns: commissionCols,
            exportName: "Commissions",
            getRowId: (r: CommissionRow, i: number) => `${r.run_date}-${r.beneficiary}-${i}`,
        },
    ][tab];

    const handleExport = () => exportSheet(current.exportName, current.data);

    const handleRefresh = () => current.refetch();

    return (
        <Stack gap={2}>
            <Typography variant="h5" fontWeight={700}>Reports</Typography>

            {/* Filters toolbar */}
            <Box
                sx={{
                    p: 2,
                    background: "#fff",
                    border: "1px solid #e5e7eb",
                    borderRadius: 2,
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", sm: "repeat(5, 1fr)" },
                    gap: 2,
                    alignItems: "center",
                }}
            >
                <TextField
                    label="Date From (UTC)"
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    size="small"
                    InputLabelProps={{ shrink: true }}
                />
                <TextField
                    label="Date To (UTC)"
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    size="small"
                    InputLabelProps={{ shrink: true }}
                />

                {/* Company filter (used by employee-based tabs; harmless on others) */}
                <FormControl size="small">
                    <InputLabel>Company (opt)</InputLabel>
                    <Select
                        label="Company (opt)"
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                    >
                        {companyOptions.map((c) => (
                            <MenuItem key={c || "(any)"} value={c}>
                                {c || "(any)"}
                            </MenuItem>
                        ))}
                    </Select>
                </FormControl>

                {/* Beneficiary for commissions */}
                <TextField
                    label="Beneficiary (opt)"
                    placeholder="danny"
                    value={beneficiary}
                    onChange={(e) => setBeneficiary(e.target.value)}
                    size="small"
                />

                <Stack direction="row" gap={1}>
                    <Button
                        onClick={handleRefresh}
                        startIcon={<RefreshIcon />}
                        variant="outlined"
                    >
                        Refresh
                    </Button>
                    <Button
                        onClick={handleExport}
                        startIcon={<DownloadIcon />}
                        variant="contained"
                    >
                        Export
                    </Button>
                </Stack>
            </Box>

            {/* Tabs */}
            <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
                <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile>
                    <Tab label="Hours by Company" />
                    <Tab label="Hours by Employee" />
                    <Tab label="Payout by Company" />
                    <Tab label="Payout by Employee" />
                    <Tab label="Commissions" />
                </Tabs>
            </Box>

            {/* Table */}
            <Box sx={{ width: "100%", bgcolor: "background.paper", borderRadius: 2 }}>
                <DataGrid
                    rows={current.data}
                    columns={current.columns as GridColDef[]}
                    getRowId={current.getRowId as any}
                    loading={current.loading}
                    disableRowSelectionOnClick
                    autoHeight
                    initialState={{
                        pagination: { paginationModel: { pageSize: 25, page: 0 } },
                        sorting: { sortModel: [{ field: "run_date", sort: "desc" }] },
                    }}
                    pageSizeOptions={[10, 25, 50, 100]}
                    sx={{
                        borderRadius: 2,
                        "& .MuiDataGrid-columnHeaders": { background: "#f3f4f6", fontWeight: 600 },
                    }}
                />
            </Box>
        </Stack>
    );
}
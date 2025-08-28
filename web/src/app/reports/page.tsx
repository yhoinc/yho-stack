"use client";

import { useEffect, useMemo, useState } from "react";

const API = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

// ---- Types returned by your API ----
type HoursByCompanyRow = {
  company: string | null;
  run_date: string;       // "YYYY-MM-DD"
  total_hours: number;
};

type HoursByEmployeeRow = {
  employee_id: string;
  name: string;
  company: string | null;
  run_date: string;       // "YYYY-MM-DD"
  total_hours: number;
};

type PayoutByCompanyRow = {
  company: string | null;
  run_date: string;       // "YYYY-MM-DD"
  total_payout: number;
};

type PayoutByEmployeeRow = {
  employee_id: string;
  name: string;
  company: string | null;
  run_date: string;       // "YYYY-MM-DD"
  total_paid: number;
};

type CommissionsRow = {
  beneficiary: string;
  run_date: string;       // "YYYY-MM-DD"
  per_hour_rate: number;
  source_hours: number;
  total_commission: number;
};

// ---- Helpers ----
function money(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function dt(ymd: string) {
  // Render YYYY-MM-DD in locale format (safe)
  const d = new Date(ymd + "T00:00:00Z");
  return isNaN(d.getTime()) ? ymd : d.toLocaleDateString();
}

// ---- Component ----
export default function ReportsPage() {
  // filters (explicit string | "" types)
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [company, setCompany] = useState<string>("");

  // data (explicit array types so they are NOT `never[]`)
  const [hCompany, setHCompany] = useState<HoursByCompanyRow[]>([]);
  const [hEmployee, setHEmployee] = useState<HoursByEmployeeRow[]>([]);
  const [pCompany, setPCompany] = useState<PayoutByCompanyRow[]>([]);
  const [pEmployee, setPEmployee] = useState<PayoutByEmployeeRow[]>([]);
  const [comm, setComm] = useState<CommissionsRow[]>([]);

  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const qs = useMemo(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    return params.toString();
  }, [dateFrom, dateTo]);

  async function loadAll() {
    setLoading(true);
    setErr(null);
    try {
      // Hours by company
      {
        const url = `${API}/payroll/summary/hours_by_company${qs ? `?${qs}` : ""}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`hours_by_company ${r.status}`);
        const j = (await r.json()) as { rows: HoursByCompanyRow[] };
        setHCompany(j.rows ?? []);
      }
      // Hours by employee (optionally filtered by company)
      {
        const params = new URLSearchParams(qs);
        if (company) params.set("company", company);
        const url = `${API}/payroll/summary/hours_by_employee${params.toString() ? `?${params}` : ""}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`hours_by_employee ${r.status}`);
        const j = (await r.json()) as { rows: HoursByEmployeeRow[] };
        setHEmployee(j.rows ?? []);
      }
      // Payout by company
      {
        const url = `${API}/payroll/summary/payout_by_company${qs ? `?${qs}` : ""}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`payout_by_company ${r.status}`);
        const j = (await r.json()) as { rows: PayoutByCompanyRow[] };
        setPCompany(j.rows ?? []);
      }
      // Payout by employee (optionally filtered by company)
      {
        const params = new URLSearchParams(qs);
        if (company) params.set("company", company);
        const url = `${API}/payroll/summary/payout_by_employee${params.toString() ? `?${params}` : ""}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`payout_by_employee ${r.status}`);
        const j = (await r.json()) as { rows: PayoutByEmployeeRow[] };
        setPEmployee(j.rows ?? []);
      }
      // Commissions (optional: a single beneficiary filter could be added like company)
      {
        const url = `${API}/payroll/summary/commissions${qs ? `?${qs}` : ""}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`commissions ${r.status}`);
        const j = (await r.json()) as { rows: CommissionsRow[] };
        setComm(j.rows ?? []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  // Initial load
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-load when filters change
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, company]);

  // Derive list of companies from the data (safe typing)
  const companyChoices = useMemo(() => {
    const s = new Set<string>();
    for (const r of hCompany) {
      if (r.company) s.add(r.company);
    }
    // also include those present in hours_by_employee/payout_by_employee in case
    for (const r of hEmployee) if (r.company) s.add(r.company);
    for (const r of pCompany) if (r.company) s.add(r.company);
    for (const r of pEmployee) if (r.company) s.add(r.company);
    return Array.from(s).sort();
  }, [hCompany, hEmployee, pCompany, pEmployee]);

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-2xl font-semibold">Reports</h1>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <div className="mb-1 font-medium">From</div>
            <input
              type="date"
              value={dateFrom}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDateFrom(e.target.value)}
              className="rounded-md border px-2 py-1"
            />
          </label>
          <label className="text-sm">
            <div className="mb-1 font-medium">To</div>
            <input
              type="date"
              value={dateTo}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDateTo(e.target.value)}
              className="rounded-md border px-2 py-1"
            />
          </label>
          <label className="text-sm">
            <div className="mb-1 font-medium">Company</div>
            <select
              value={company}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCompany(e.target.value)}
              className="rounded-md border px-2 py-1"
            >
              <option value="">All</option>
              {companyChoices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={loadAll}
            disabled={loading}
            className="rounded-md bg-blue-600 px-3 py-2 text-white disabled:opacity-60"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      {err && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      {/* Hours by Company */}
      <section className="rounded-lg border bg-white">
        <div className="border-b px-4 py-3 font-semibold">Hours by Company</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Total Hours</th>
              </tr>
            </thead>
            <tbody>
              {hCompany.length === 0 ? (
                <tr><td className="px-3 py-4 text-gray-500" colSpan={3}>No data.</td></tr>
              ) : (
                hCompany.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2">{dt(r.run_date)}</td>
                    <td className="px-3 py-2">{r.company ?? "—"}</td>
                    <td className="px-3 py-2">{r.total_hours.toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Hours by Employee */}
      <section className="rounded-lg border bg-white">
        <div className="border-b px-4 py-3 font-semibold">Hours by Employee {company ? `— ${company}` : ""}</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Employee</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Total Hours</th>
              </tr>
            </thead>
            <tbody>
              {hEmployee.length === 0 ? (
                <tr><td className="px-3 py-4 text-gray-500" colSpan={4}>No data.</td></tr>
              ) : (
                hEmployee.map((r) => (
                  <tr key={`${r.employee_id}-${r.run_date}`} className="border-t">
                    <td className="px-3 py-2">{dt(r.run_date)}</td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2">{r.company ?? "—"}</td>
                    <td className="px-3 py-2">{r.total_hours.toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Payout by Company */}
      <section className="rounded-lg border bg-white">
        <div className="border-b px-4 py-3 font-semibold">Payout by Company</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Total Payout</th>
              </tr>
            </thead>
            <tbody>
              {pCompany.length === 0 ? (
                <tr><td className="px-3 py-4 text-gray-500" colSpan={3}>No data.</td></tr>
              ) : (
                pCompany.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2">{dt(r.run_date)}</td>
                    <td className="px-3 py-2">{r.company ?? "—"}</td>
                    <td className="px-3 py-2">{money(r.total_payout)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Payout by Employee */}
      <section className="rounded-lg border bg-white">
        <div className="border-b px-4 py-3 font-semibold">Payout by Employee {company ? `— ${company}` : ""}</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Employee</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Total Paid</th>
              </tr>
            </thead>
            <tbody>
              {pEmployee.length === 0 ? (
                <tr><td className="px-3 py-4 text-gray-500" colSpan={4}>No data.</td></tr>
              ) : (
                pEmployee.map((r) => (
                  <tr key={`${r.employee_id}-${r.run_date}`} className="border-t">
                    <td className="px-3 py-2">{dt(r.run_date)}</td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2">{r.company ?? "—"}</td>
                    <td className="px-3 py-2">{money(r.total_paid)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Commissions */}
      <section className="rounded-lg border bg-white">
        <div className="border-b px-4 py-3 font-semibold">Commissions</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Beneficiary</th>
                <th className="px-3 py-2">Per-hour Rate</th>
                <th className="px-3 py-2">Source Hours</th>
                <th className="px-3 py-2">Total Commission</th>
              </tr>
            </thead>
            <tbody>
              {comm.length === 0 ? (
                <tr><td className="px-3 py-4 text-gray-500" colSpan={5}>No data.</td></tr>
              ) : (
                comm.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2">{dt(r.run_date)}</td>
                    <td className="px-3 py-2">{r.beneficiary}</td>
                    <td className="px-3 py-2">{money(r.per_hour_rate)}</td>
                    <td className="px-3 py-2">{r.source_hours.toFixed(2)}</td>
                    <td className="px-3 py-2">{money(r.total_commission)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

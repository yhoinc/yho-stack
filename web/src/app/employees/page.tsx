"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ============================== Config =============================== */

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

/* =============================== Types =============================== */

type Stringish = string | number | null | undefined;

interface Employee {
  employee_id?: number | string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  company?: string;
  department?: string;
  title?: string;
  city?: string;
  state?: string;
  location?: string; // if your API provides a combined field
  // Accept unknown extra fields without using `any`
  [k: string]: unknown;
}

interface EmployeesEnvelope {
  rows?: Employee[];
  total?: number;
}

/* ============================== Helpers ============================= */

function u(path: string) {
  return API_BASE ? `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}` : path;
}

async function apiJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text().catch(() => `${res.status} ${res.statusText}`));
  return (await res.json()) as T;
}

function coalesce(...vals: Stringish[]): string {
  for (const v of vals) {
    if (v !== undefined && v !== null && `${v}`.trim() !== "") return `${v}`.trim();
  }
  return "";
}

function fullName(e: Employee): string {
  return coalesce(e.name, `${coalesce(e.first_name)} ${coalesce(e.last_name)}`.trim());
}

function place(e: Employee): string {
  return coalesce(e.location, [coalesce(e.city), coalesce(e.state)].filter(Boolean).join(", "));
}

/* ================================ UI ================================= */

export default function EmployeesPage() {
  const [rows, setRows] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // search (debounced)
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const debounceTimer = useRef<number | null>(null);

  useEffect(() => {
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => setDebounced(query), 250);
    return () => {
      if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
    };
  }, [query]);

  // fetch employees
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setErr(null);
      try {
        const url = new URL(u("/employees"), window.location.href);
        url.searchParams.set("limit", "2000");
        const data = await apiJson<EmployeesEnvelope | Employee[]>(url.toString());
        const list: Employee[] = Array.isArray(data)
          ? data
          : Array.isArray((data as EmployeesEnvelope).rows)
          ? ((data as EmployeesEnvelope).rows as Employee[])
          : [];
        setRows(list);
      } catch (e) {
        setErr((e as Error).message);
        setRows([]);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  // filter
  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return rows;

    return rows.filter((e) => {
      const bucket = [
        fullName(e),
        e.email,
        e.title,
        e.department,
        e.company,
        place(e),
        // also let generic keys help search without using `any`
        ...Object.entries(e)
          .filter(([k]) => !["employee_id", "first_name", "last_name"].includes(k))
          .map(([, v]) => (typeof v === "string" || typeof v === "number" ? `${v}` : "")),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return bucket.includes(q);
    });
  }, [rows, debounced]);

  return (
    <div className="mx-auto max-w-7xl p-4 space-y-6">
      {/* Header / Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="text-sm text-slate-500">
            Search by name, email, title, department, company, or location.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="w-72 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="Search employees…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-500">Total</div>
          <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-500">Matching</div>
          <div className="mt-1 text-2xl font-semibold">{filtered.length}</div>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-500">Backend</div>
          <div className="mt-1 truncate text-slate-700">{API_BASE || "(same origin)"}</div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left">
              <tr className="text-slate-600">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Department</th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Location</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-slate-500" colSpan={6}>
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-slate-500" colSpan={6}>
                    No employees found.
                  </td>
                </tr>
              ) : (
                filtered.map((e) => (
                  <tr key={`${e.employee_id ?? fullName(e)}`} className="border-t">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{fullName(e) || "—"}</div>
                      {e.employee_id ? (
                        <div className="text-xs text-slate-500">ID: {e.employee_id}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">{coalesce(e.title, "—")}</td>
                    <td className="px-4 py-3">{coalesce(e.department, "—")}</td>
                    <td className="px-4 py-3">{coalesce(e.company, "—")}</td>
                    <td className="px-4 py-3">
                      {e.email ? (
                        <a className="text-indigo-700 hover:underline" href={`mailto:${e.email}`}>
                          {e.email}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{place(e) || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 text-xs text-slate-500">{filtered.length} employee(s)</div>
      </div>
    </div>
  );
}

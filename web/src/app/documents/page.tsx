"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ============================== Config =============================== */

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

/* =============================== Types =============================== */

type IsoDate = string;

interface DocRow {
  key: string;
  size: number;
  last_modified: IsoDate | null;
  url?: string;
}

interface ListResponse {
  rows: DocRow[];
  page: number;
  page_size: number;
  total: number;
}

/* ============================== Helpers ============================= */

function u(url: string) {
  return API_BASE ? `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}` : url;
}

async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    cache: "no-store",
    headers: { ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text().catch(() => `${res.status} ${res.statusText}`));
  return (await res.json()) as T;
}

function bytesHuman(n: number): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function badge(text: string, color: "indigo" | "emerald" | "slate" | "rose" | "amber") {
  const map: Record<typeof color, string> = {
    indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    slate: "bg-slate-50 text-slate-700 ring-slate-200",
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${map[color]}`}>
      {text}
    </span>
  );
}

/* =============================== Page =============================== */

export default function DocumentsPage() {
  /* ---------- data ---------- */
  const [rows, setRows] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* ---------- filtering ---------- */
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q));
  }, [rows, query]);

  /* ---------- upload form ---------- */
  const [employeeName, setEmployeeName] = useState("");
  const [docTypes, setDocTypes] = useState<{ tax: boolean; id: boolean; dd: boolean; custom: boolean }>({
    tax: false,
    id: false,
    dd: false,
    custom: false,
  });
  const [customLabel, setCustomLabel] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const listUrl = new URL(u("/documents"), window.location.href);
      listUrl.searchParams.set("limit", "500");
      const data = await apiJson<ListResponse>(listUrl.toString());
      setRows(data.rows);
    } catch (e) {
      setErr((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const sync = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      await apiJson<{ ok: boolean }>(u("/documents/sync"), { method: "GET" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleType = (k: keyof typeof docTypes) => setDocTypes((p) => ({ ...p, [k]: !p[k] }));

  const onUpload = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return alert("Please choose a file.");

    const name = employeeName.trim();
    if (!name) return alert("Please enter an employee name.");

    // Build doc types
    const types: string[] = [];
    if (docTypes.tax) types.push("tax");
    if (docTypes.id) types.push("id");
    if (docTypes.dd) types.push("direct_deposit");

    if (docTypes.custom) {
      const label = customLabel.trim();
      if (!label) return alert("Enter a custom document label.");
      // be conservative: kebab/underscore safe
      const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      types.push(`custom:${safe}`);
    }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("employee_name", name);
    fd.append("doc_types", types.join(","));
    // optional: send original custom label too (backend can ignore)
    if (docTypes.custom) fd.append("custom_label", customLabel.trim());

    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(u("/documents/upload"), { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      // reset
      if (fileRef.current) fileRef.current.value = "";
      setEmployeeName("");
      setDocTypes({ tax: false, id: false, dd: false, custom: false });
      setCustomLabel("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [customLabel, docTypes, employeeName, load]);

  const openSignedUrl = useCallback(async (key: string, disposition: "inline" | "attachment") => {
    try {
      const url = new URL(u("/documents/signed-url"), window.location.href);
      url.searchParams.set("key", key);
      url.searchParams.set("disposition", disposition);
      const doc = await apiJson<DocRow>(url.toString());
      if (!doc.url) throw new Error("No signed URL returned.");
      window.open(doc.url, "_blank", "noopener");
    } catch (e) {
      alert(`Failed to open document: ${(e as Error).message}`);
    }
  }, []);

  /* ---------- derived stats ---------- */
  const totalSize = useMemo(() => rows.reduce((s, r) => s + (r.size || 0), 0), [rows]);

  /* ============================== UI ================================= */

  return (
    <div className="mx-auto max-w-7xl p-4 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employee Documents</h1>
          <p className="text-sm text-slate-500">
            Manage and retrieve employee documents stored in secure object storage.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            onClick={sync}
            disabled={loading}
          >
            Sync with Bucket
          </button>
          <div className="relative">
            <input
              className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Search file, employee, type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="absolute right-2 top-2.5 text-slate-400">⌘K</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-500">Files</div>
          <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-500">Total Size</div>
          <div className="mt-1 text-2xl font-semibold">{bytesHuman(totalSize)}</div>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-500">Backend</div>
          <div className="mt-1 truncate text-slate-700">{API_BASE || "(same origin)"}</div>
        </div>
      </div>

      {/* Upload Card */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-medium">Upload</h2>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-slate-600">Employee Name</span>
            <input
              className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. Jane Doe"
              value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)}
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-sm text-slate-600">Document Type(s)</span>
            <div className="flex flex-wrap gap-4 rounded-md border border-slate-200 px-3 py-2">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={docTypes.tax} onChange={() => toggleType("tax")} />
                Tax Form
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={docTypes.id} onChange={() => toggleType("id")} />
                Identification
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={docTypes.dd} onChange={() => toggleType("dd")} />
                Direct Deposit Form
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={docTypes.custom} onChange={() => toggleType("custom")} />
                Custom
              </label>
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-slate-600">File</span>
            <input ref={fileRef} type="file" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
        </div>

        {/* Custom label row */}
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className={`flex flex-col gap-1 ${docTypes.custom ? "" : "opacity-40"}`}>
            <span className="text-sm text-slate-600">Custom Label</span>
            <input
              className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50"
              placeholder="e.g. offer_letter"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              disabled={!docTypes.custom}
            />
            <span className="text-xs text-slate-500">
              Letters/numbers will be converted to a safe identifier for storage keys.
            </span>
          </label>
        </div>

        <div className="mt-4">
          <button
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            onClick={onUpload}
            disabled={loading}
          >
            Upload
          </button>
          {err && (
            <span className="ml-3 text-sm text-rose-600 align-middle" role="alert">
              {err}
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left">
              <tr className="text-slate-600">
                <th className="px-4 py-3 font-medium">File</th>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Size</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Modified</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-slate-500" colSpan={6}>
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-slate-500" colSpan={6}>
                    No documents found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const filename = r.key.split("/").pop() ?? r.key;

                  // Optional parsing: Your uploader builds keys like
                  // "Employee Name__tax_id_custom-offer_letter__original.pdf".
                  const parts = filename.split("__");
                  const employee = parts[0] ?? "";
                  const typeTokens = (parts[1] ?? "").split("_").filter(Boolean);

                  return (
                    <tr key={r.key} className="border-t">
                      <td className="px-4 py-3">{filename}</td>
                      <td className="px-4 py-3">{employee || "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {typeTokens.length === 0 && badge("unknown", "slate")}
                          {typeTokens.map((tkn) => {
                            const pretty = tkn.replace(/^custom:/, "").replace(/_/g, " ");
                            const color =
                              tkn.startsWith("custom:") ? "amber" : tkn === "tax" ? "indigo" : tkn === "id" ? "slate" : "emerald";
                            return <span key={tkn}>{badge(pretty, color)}</span>;
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{bytesHuman(r.size)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {r.last_modified ? new Date(r.last_modified).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded bg-blue-600 px-2.5 py-1 text-white hover:bg-blue-700"
                            onClick={() => openSignedUrl(r.key, "inline")}
                          >
                            View
                          </button>
                          <button
                            className="rounded bg-slate-700 px-2.5 py-1 text-white hover:bg-slate-800"
                            onClick={() => openSignedUrl(r.key, "attachment")}
                          >
                            Download
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-2 text-xs text-slate-500">{filtered.length} file(s)</div>
      </div>
    </div>
  );
}

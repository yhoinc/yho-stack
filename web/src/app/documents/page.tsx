"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Where the API lives (leave blank for same-origin). */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

/* ============================== Types =============================== */

type IsoDate = string;

interface DocRow {
  key: string;
  size: number;                 // bytes
  last_modified: IsoDate | null;
  url?: string;                 // returned by /documents/signed-url
}

interface ListResponse {
  rows: DocRow[];
  page: number;
  page_size: number;
  total: number;
}

/* ============================== Utils =============================== */

function joinUrl(base: string, path: string) {
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function bytesHuman(n: number): string {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** conservative “label to slug” for the custom type */
function slugifyCustom(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-]+/g, "");
}

/* ============================== Page ================================ */

export default function DocumentsPage() {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // search/filter
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter((r) => r.key.toLowerCase().includes(q));
  }, [rows, query]);

  // upload form state
  const [employeeName, setEmployeeName] = useState("");
  const [docTax, setDocTax] = useState(false);
  const [docId, setDocId] = useState(false);
  const [docDd, setDocDd] = useState(false);
  const [docCustom, setDocCustom] = useState(false);
  const [customLabel, setCustomLabel] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const url = new URL(joinUrl(API_BASE, "/documents"), window.location.href);
      url.searchParams.set("limit", "500");
      const data = await apiJson<ListResponse>(url.toString());
      setRows(data.rows);
    } catch (e) {
      setErr((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const syncWithBucket = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      await apiJson<{ ok: boolean }>(joinUrl(API_BASE, "/documents/sync"), {
        method: "GET",
      });
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

  const onUpload = useCallback(async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) return alert("Choose a file to upload.");
    const name = employeeName.trim();
    if (!name) return alert("Enter an employee name.");

    const selected: string[] = [];
    if (docTax) selected.push("tax");
    if (docId) selected.push("id");
    if (docDd) selected.push("direct_deposit");
    if (docCustom) {
      const c = slugifyCustom(customLabel);
      if (!c) return alert("Enter a custom type label (letters/numbers/spaces).");
      selected.push(`custom:${c}`);
    }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("employee_name", name);
    fd.append("doc_types", selected.join(",")); // backend already uses this

    setLoading(true);
    setErr(null);
    try {
      await fetch(joinUrl(API_BASE, "/documents/upload"), { method: "POST", body: fd }).then(
        async (r) => {
          if (!r.ok) throw new Error(await r.text());
        }
      );
      // reset
      if (fileInput.current) fileInput.current.value = "";
      setEmployeeName("");
      setDocTax(false);
      setDocId(false);
      setDocDd(false);
      setDocCustom(false);
      setCustomLabel("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [employeeName, docTax, docId, docDd, docCustom, customLabel, load]);

  const openSignedUrl = useCallback(async (key: string, disposition: "inline" | "attachment") => {
    try {
      const url = new URL(joinUrl(API_BASE, "/documents/signed-url"), window.location.href);
      url.searchParams.set("key", key);
      url.searchParams.set("disposition", disposition);
      const doc = await apiJson<DocRow>(url.toString());
      if (!doc.url) return alert("No signed URL returned.");
      window.open(doc.url, "_blank", "noopener");
    } catch (e) {
      alert(`Failed to get signed URL: ${(e as Error).message}`);
    }
  }, []);

  /* ---------- lightweight key parsing for display ---------- */
  function parseRow(r: DocRow) {
    const filename = r.key.split("/").pop() ?? r.key;
    const parts = filename.split("__"); // employee__types__original.ext
    const employee = parts[0] ?? "";
    const typeHint = parts.length > 1 ? parts[1].replace(/_/g, ", ") : "";
    return { filename, employee, typeHint };
  }

  return (
    <div className="mx-auto max-w-7xl p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Employee Documents</h1>
          <p className="mt-1 text-sm text-gray-500">
            Upload and manage staff documents. Use the search to quickly filter files.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="rounded-lg bg-indigo-600 px-3 py-2 text-white shadow hover:bg-indigo-700 disabled:opacity-60"
            onClick={syncWithBucket}
            disabled={loading}
            title="Re-scan the bucket and refresh metadata"
          >
            {loading ? "Syncing…" : "Sync with Bucket"}
          </button>

          <input
            className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="Search by file / employee / type…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Errors */}
      {err && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* Upload card */}
      <section className="rounded-xl border bg-white/60 p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-medium">Upload</h2>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">Employee Name</span>
            <input
              className="rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. Jane Doe"
              value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)}
            />
            <span className="text-xs text-gray-400">Used in the stored file name.</span>
          </label>

          <div className="col-span-1 md:col-span-2">
            <span className="mb-1 block text-sm text-gray-600">Document Type(s)</span>
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={docTax} onChange={() => setDocTax((s) => !s)} />
                <span>Tax Form</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={docId} onChange={() => setDocId((s) => !s)} />
                <span>Identification</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={docDd} onChange={() => setDocDd((s) => !s)} />
                <span>Direct Deposit Form</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={docCustom} onChange={() => setDocCustom((s) => !s)} />
                <span>Custom</span>
              </label>

              <input
                className="min-w-[14rem] rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="e.g. certification, NDA…"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                disabled={!docCustom}
              />
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Custom label is normalized (e.g., <code>“Safety Card” → custom:safety_card</code>).
            </p>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">File</span>
            <input ref={fileInput} type="file" />
          </label>
        </div>

        <div className="mt-4">
          <button
            className="rounded-lg bg-emerald-600 px-4 py-2 text-white shadow hover:bg-emerald-700 disabled:opacity-60"
            onClick={onUpload}
            disabled={loading}
          >
            {loading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </section>

      {/* Results card */}
      <section className="rounded-xl border bg-white/60 shadow-sm">
        <div className="border-b px-5 py-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Files</h2>
            <span className="text-sm text-gray-500">{filtered.length} result(s)</span>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium text-gray-700">File</th>
                <th className="px-4 py-2 font-medium text-gray-700">Employee</th>
                <th className="px-4 py-2 font-medium text-gray-700">Type</th>
                <th className="px-4 py-2 font-medium text-gray-700">Size</th>
                <th className="px-4 py-2 font-medium text-gray-700">Modified</th>
                <th className="px-4 py-2 font-medium text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-gray-500" colSpan={6}>
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-gray-500" colSpan={6}>
                    No documents found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const { filename, employee, typeHint } = parseRow(r);
                  return (
                    <tr key={r.key} className="border-t">
                      <td className="px-4 py-3">{filename}</td>
                      <td className="px-4 py-3">{employee || "—"}</td>
                      <td className="px-4 py-3">{typeHint || "—"}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{bytesHuman(r.size)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {r.last_modified ? new Date(r.last_modified).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded-md bg-blue-600 px-2.5 py-1.5 text-white hover:bg-blue-700"
                            onClick={() => openSignedUrl(r.key, "inline")}
                            title="Open in a new tab"
                          >
                            View
                          </button>
                          <button
                            className="rounded-md bg-gray-700 px-2.5 py-1.5 text-white hover:bg-gray-800"
                            onClick={() => openSignedUrl(r.key, "attachment")}
                            title="Download"
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

        <div className="border-t px-5 py-2 text-xs text-gray-500">
          Backend: <code>{API_BASE || "(same origin)"}</code>
        </div>
      </section>
    </div>
  );
}

"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Where the API lives.
 * - If NEXT_PUBLIC_API_BASE is defined (e.g. https://yho-stack.onrender.com) we call that.
 * - Otherwise we call relative paths (same origin).
 */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

/* ============================== Types =============================== */

type IsoDate = string;

interface DocRow {
  key: string;
  size: number;                 // bytes, 0 if unknown
  last_modified: IsoDate | null;
  url?: string;                 // only present when requesting /signed-url
}

interface ListResponse {
  rows: DocRow[];
  page: number;
  page_size: number;
  total: number;
}

/* ============================== Helpers ============================= */

function joinUrl(base: string, path: string) {
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    // try to surface server error text
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
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

/* ============================== UI ================================= */

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

  // upload form
  const [employeeName, setEmployeeName] = useState("");
  const [docTypes, setDocTypes] = useState<{ tax: boolean; id: boolean; dd: boolean }>({
    tax: false,
    id: false,
    dd: false,
  });
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
      const url = joinUrl(API_BASE, "/documents/sync");
      // backend uses GET; if you switch to POST, change here.
      await apiJson<{ ok: boolean }>(url, { method: "GET" });
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

  const toggleType = (key: "tax" | "id" | "dd") =>
    setDocTypes((prev) => ({ ...prev, [key]: !prev[key] }));

  const onUpload = useCallback(async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      alert("Choose a file to upload.");
      return;
    }
    const name = employeeName.trim();
    if (!name) {
      alert("Enter an employee name.");
      return;
    }
    const selectedTypes: string[] = [];
    if (docTypes.tax) selectedTypes.push("tax");
    if (docTypes.id) selectedTypes.push("id");
    if (docTypes.dd) selectedTypes.push("direct_deposit");

    const fd = new FormData();
    fd.append("file", file);
    fd.append("employee_name", name);
    fd.append("doc_types", selectedTypes.join(",")); // backend uses this to suffix the key

    setLoading(true);
    setErr(null);
    try {
      await fetch(joinUrl(API_BASE, "/documents/upload"), {
        method: "POST",
        body: fd,
      }).then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
      });
      // reset inputs
      if (fileInput.current) fileInput.current.value = "";
      setEmployeeName("");
      setDocTypes({ tax: false, id: false, dd: false });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [employeeName, docTypes, load]);

  const openSignedUrl = useCallback(async (key: string, disposition: "inline" | "attachment" = "inline") => {
    try {
      const url = new URL(joinUrl(API_BASE, "/documents/signed-url"), window.location.href);
      url.searchParams.set("key", key);
      url.searchParams.set("disposition", disposition);
      const doc = await apiJson<DocRow>(url.toString());
      if (!doc.url) {
        alert("No signed URL returned.");
        return;
      }
      window.open(doc.url, "_blank", "noopener");
    } catch (e) {
      alert(`Failed to get signed URL: ${(e as Error).message}`);
    }
  }, []);

  return (
    <div className="mx-auto max-w-7xl p-4">
      <h1 className="text-2xl font-semibold mb-4">Employee Documents</h1>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-700 disabled:opacity-50"
          onClick={syncWithBucket}
          disabled={loading}
          title="Re-scan bucket into metadata table"
        >
          Sync with Bucket
        </button>

        <input
          className="rounded border px-3 py-1.5"
          placeholder="Search by file/employee/type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 260 }}
        />

        <span className="ml-auto text-sm text-gray-500">
          Backend base: <code>{API_BASE || "(same origin)"}</code>
        </span>
      </div>

      {err && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* Upload form */}
      <div className="mb-6 rounded-lg border p-4">
        <div className="mb-2 font-medium">Upload File</div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex flex-col">
            <label className="text-sm text-gray-600 mb-1">Employee Name</label>
            <input
              className="rounded border px-3 py-1.5"
              placeholder="e.g. Jane Doe"
              value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)}
            />
          </div>

          <div className="flex flex-col">
            <span className="text-sm text-gray-600 mb-1">Document Type(s)</span>
            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={docTypes.tax} onChange={() => toggleType("tax")} />
                <span>Tax Form</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={docTypes.id} onChange={() => toggleType("id")} />
                <span>Identification</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={docTypes.dd} onChange={() => toggleType("dd")} />
                <span>Direct Deposit Form</span>
              </label>
            </div>
          </div>

          <div className="flex flex-col">
            <label className="text-sm text-gray-600 mb-1">File</label>
            <input ref={fileInput} type="file" />
          </div>
        </div>

        <div className="mt-3">
          <button
            className="rounded bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-700 disabled:opacity-50"
            onClick={onUpload}
            disabled={loading}
          >
            Upload
          </button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-lg border">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 font-medium">Employee</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Modified</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-gray-500" colSpan={6}>
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="px-3 py-3 text-gray-500" colSpan={6}>
                    No documents found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const filename = r.key.split("/").pop() ?? r.key;
                  // very light parsing: assume pattern like `Employee Name__type1_type2__original.pdf`
                  const parts = filename.split("__");
                  const employee = parts[0] ?? "";
                  const typeHint = parts.length > 1 ? parts[1].replace(/_/g, ", ") : "";

                  return (
                    <tr key={r.key} className="border-t">
                      <td className="px-3 py-2">{filename}</td>
                      <td className="px-3 py-2">{employee || "—"}</td>
                      <td className="px-3 py-2">{typeHint || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{bytesHuman(r.size)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.last_modified ? new Date(r.last_modified).toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700"
                            onClick={() => openSignedUrl(r.key, "inline")}
                            title="Open in a new tab"
                          >
                            View
                          </button>
                          <button
                            className="rounded bg-gray-700 px-2 py-1 text-white hover:bg-gray-800"
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

        <div className="px-3 py-2 text-xs text-gray-500">
          {filtered.length} file(s){loading ? " • loading…" : null}
        </div>
      </div>
    </div>
  );
}

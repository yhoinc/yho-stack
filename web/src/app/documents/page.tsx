"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type DocRow = {
  key: string;
  filename: string;
  size: number;         // bytes
  content_type: string; // e.g. application/pdf
  uploaded_at: string;  // ISO
  employee?: string | null;
  doc_type?: string | null;
};

const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// simple bytes → human string
function fmtBytes(b: number): string {
  if (b === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function DocumentsPage() {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");
  const [syncing, setSyncing] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const empRef = useRef<HTMLInputElement | null>(null);
  const taxRef = useRef<HTMLInputElement | null>(null);
  const idRef = useRef<HTMLInputElement | null>(null);
  const ddRef = useRef<HTMLInputElement | null>(null);

  // ----------- data fetching ----------- //
  async function fetchList() {
    setLoading(true);
    try {
      const r = await fetch(`${API}/documents`, { method: "GET", cache: "no-store" });
      if (!r.ok) throw new Error(`List failed (${r.status})`);
      const data = await r.json() as { rows: DocRow[] };
      setRows(data.rows ?? []);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------- sync button ----------- //
  async function syncFromBucket() {
    setSyncing(true);
    try {
      const r = await fetch(`${API}/documents`, { method: "GET", cache: "no-store" });
      if (!r.ok) throw new Error(`Sync failed (${r.status})`);
      const data = await r.json() as { rows: DocRow[] };
      setRows(data.rows ?? []);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  // ----------- upload ----------- //
  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      alert("Choose a file first.");
      return;
    }
    const employee = empRef.current?.value?.trim() || "";
    const parts: string[] = [];
    if (taxRef.current?.checked) parts.push("tax");
    if (idRef.current?.checked) parts.push("id");
    if (ddRef.current?.checked) parts.push("directdeposit");
    const docType = parts.join("_");

    const formData = new FormData();
    formData.append("file", file);
    if (employee) formData.append("employee", employee);
    if (docType) formData.append("doc_type", docType);

    setUploading(true);
    try {
      const r = await fetch(`${API}/documents/upload`, {
        method: "POST",
        body: formData,
      });
      if (!r.ok) throw new Error(`Upload failed (${r.status})`);
      // refresh list
      await fetchList();
      // reset inputs
      if (fileRef.current) fileRef.current.value = "";
      if (empRef.current) empRef.current.value = "";
      if (taxRef.current) taxRef.current.checked = false;
      if (idRef.current) idRef.current.checked = false;
      if (ddRef.current) ddRef.current.checked = false;
      setError(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  // ----------- actions ----------- //
  function previewUrl(key: string, inline = true) {
    const disp = inline ? "inline" : "attachment";
    // FastAPI endpoint streams file with optional disposition
    return `${API}/documents/${encodeURIComponent(key)}?disposition=${disp}`;
  }

  async function deleteDoc(key: string) {
    if (!confirm("Delete this document?")) return;
    try {
      const r = await fetch(`${API}/documents/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`Delete failed (${r.status})`);
      setRows((prev) => prev.filter((x) => x.key !== key));
    } catch (e: unknown) {
      alert((e as Error).message);
    }
  }

  // ----------- filter on client ----------- //
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      return (
        r.filename.toLowerCase().includes(q) ||
        (r.employee ?? "").toLowerCase().includes(q) ||
        (r.doc_type ?? "").toLowerCase().includes(q) ||
        r.key.toLowerCase().includes(q)
      );
    });
  }, [rows, query]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Employee Documents</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={syncFromBucket}
            disabled={syncing}
            className="rounded-md bg-sky-600 px-3 py-2 text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync with Bucket"}
          </button>
          <input
            placeholder="Search by file/employee/type…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-64 rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </header>

      {/* Upload form */}
      <section className="rounded-lg border border-gray-200 p-4">
        <form onSubmit={handleUpload} className="grid gap-3 md:grid-cols-3">
          <div className="flex flex-col">
            <label className="text-sm font-medium mb-1">Employee Name</label>
            <input
              ref={empRef}
              type="text"
              placeholder="e.g. Jane Doe"
              className="rounded-md border border-gray-300 px-3 py-2"
            />
          </div>

          <div className="flex flex-col">
            <span className="text-sm font-medium mb-1">Document Type(s)</span>
            <div className="flex flex-wrap gap-4 rounded-md border border-gray-200 px-3 py-2">
              <label className="flex items-center gap-2 text-sm">
                <input ref={taxRef} type="checkbox" /> Tax Form
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input ref={idRef} type="checkbox" /> Identification
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input ref={ddRef} type="checkbox" /> Direct Deposit Form
              </label>
            </div>
          </div>

          <div className="flex flex-col">
            <label className="text-sm font-medium mb-1">Upload File</label>
            <input ref={fileRef} type="file" className="rounded-md border border-gray-300 px-3 py-2" />
          </div>

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={uploading}
              className="rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
          </div>
        </form>
      </section>

      {/* List */}
      <section className="rounded-lg border border-gray-200">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 font-medium">Employee</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Uploaded</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-3 py-4 text-gray-500" colSpan={6}>
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-gray-500" colSpan={6}>
                    No documents found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.key} className="border-t">
                    <td className="px-3 py-2">
                      <div className="flex flex-col">
                        <span className="font-medium">{r.filename}</span>
                        <span className="text-gray-500">{r.key}</span>
                        <span className="text-gray-500">{r.content_type}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">{r.employee || "-"}</td>
                    <td className="px-3 py-2">{r.doc_type || "-"}</td>
                    <td className="px-3 py-2">{fmtBytes(r.size)}</td>
                    <td className="px-3 py-2">
                      {new Date(r.uploaded_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <a
                          href={previewUrl(r.key, true)}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-gray-300 px-2 py-1 hover:bg-gray-50"
                        >
                          Preview
                        </a>
                        <a
                          href={previewUrl(r.key, false)}
                          className="rounded-md border border-gray-300 px-2 py-1 hover:bg-gray-50"
                        >
                          Download
                        </a>
                        <button
                          onClick={() => deleteDoc(r.key)}
                          className="rounded-md border border-red-300 px-2 py-1 text-red-700 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {error && (
          <div className="border-t px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}

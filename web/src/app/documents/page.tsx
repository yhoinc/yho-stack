"use client";

import { useEffect, useMemo, useState } from "react";

// Where to call the API (Render: set NEXT_PUBLIC_API_BASE on the web service)
const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

type DocRow = {
  key: string;
  size: number;
  last_modified: string; // ISO string
  url?: string;          // optional, not required for list
};

type UploadState = "idle" | "uploading" | "done" | "error";

const DOC_TYPES = ["Tax Form", "Identification", "Direct Deposit Form"] as const;
type DocType = (typeof DOC_TYPES)[number];

function fmtBytes(n: number): string {
  if (n === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${parseFloat((n / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function fmtDate(iso: string): string {
  // Defensive: Cloudflare returns RFC3339/ISO—safe to new Date()
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");

  // Upload form state
  const [employeeName, setEmployeeName] = useState<string>("");
  const [selectedTypes, setSelectedTypes] = useState<DocType[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMsg, setUploadMsg] = useState<string>("");

  // Load on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // First, ensure our DB reflects the bucket contents (idempotent & fast)
        await fetch(`${API}/documents/sync`).catch(() => {
          /* if sync fails we still try list */
        });

        const res = await fetch(`${API}/documents`, { cache: "no-store" });
        if (!res.ok) throw new Error(`List failed: ${res.status}`);
        const data = (await res.json()) as DocRow[];
        if (!cancelled) setDocs(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.key.toLowerCase().includes(q));
  }, [docs, query]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`${API}/documents/sync`, { method: "POST" });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      // reload list
      const r = await fetch(`${API}/documents`, { cache: "no-store" });
      if (!r.ok) throw new Error(`Reload failed: ${r.status}`);
      setDocs((await r.json()) as DocRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function toggleType(t: DocType) {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setUploadState("error");
      setUploadMsg("Please choose a file.");
      return;
    }
    setUploadState("uploading");
    setUploadMsg("");

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("employee_name", employeeName);
      // Join selected types with comma (backend can parse)
      form.append("doc_types", selectedTypes.join(","));

      const res = await fetch(`${API}/documents/upload`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Upload failed (${res.status}) ${txt}`);
      }

      setUploadState("done");
      setUploadMsg("Uploaded!");
      setEmployeeName("");
      setSelectedTypes([]);
      setFile(null);

      // Refresh list
      const r = await fetch(`${API}/documents`, { cache: "no-store" });
      if (r.ok) setDocs((await r.json()) as DocRow[]);
    } catch (err) {
      setUploadState("error");
      setUploadMsg(err instanceof Error ? err.message : "Upload failed");
    }
  }

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Employee Documents</h1>
        <div className="flex gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
          >
            {syncing ? "Syncing…" : "Sync with Bucket"}
          </button>
        </div>
      </div>

      {/* Search + status */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by file name…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:max-w-md"
        />
        <div className="text-sm text-gray-500">
          {loading ? "Loading…" : `${filtered.length} file(s)`}
          {error ? <span className="text-red-600"> • {error}</span> : null}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-700">
            <tr>
              <th className="px-4 py-3 font-medium">File</th>
              <th className="px-4 py-3 font-medium">Size</th>
              <th className="px-4 py-3 font-medium">Modified</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && filtered.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-gray-500" colSpan={4}>
                  No documents found.
                </td>
              </tr>
            ) : (
              filtered.map((d) => {
                const viewUrl = `${API}/documents/${encodeURIComponent(d.key)}`;
                const downloadUrl = `${API}/documents/${encodeURIComponent(
                  d.key
                )}?download=1`;
                return (
                  <tr
                    key={d.key}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3">
                      <div className="max-w-[520px] truncate">{d.key}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {fmtBytes(d.size)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {fmtDate(d.last_modified)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <a
                          className="rounded-md border border-gray-300 px-3 py-1 hover:bg-gray-100"
                          href={viewUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View
                        </a>
                        <a
                          className="rounded-md bg-gray-800 px-3 py-1 text-white hover:bg-black"
                          href={downloadUrl}
                        >
                          Download
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Upload form */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-4 text-lg font-semibold">Upload Employee Documents</h2>
        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Employee Name</label>
            <input
              value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)}
              placeholder="e.g. Ana Gomez"
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:max-w-md"
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Document Type(s)</div>
            <div className="flex flex-wrap gap-2">
              {DOC_TYPES.map((t) => {
                const active = selectedTypes.includes(t);
                return (
                  <button
                    type="button"
                    key={t}
                    onClick={() => toggleType(t)}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      active
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}
                    aria-pressed={active}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Upload File</label>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-700 file:mr-4 file:rounded-md file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-white hover:file:bg-blue-700 sm:max-w-md"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={uploadState === "uploading"}
              className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
            >
              {uploadState === "uploading" ? "Uploading…" : "Upload"}
            </button>
            {uploadMsg && (
              <span
                className={`text-sm ${
                  uploadState === "error" ? "text-red-600" : "text-gray-600"
                }`}
              >
                {uploadMsg}
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

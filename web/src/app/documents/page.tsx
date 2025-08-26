"use client";

import { useEffect, useMemo, useState } from "react";

// If NEXT_PUBLIC_API_BASE is not set, we fall back to same-origin (useful in local dev proxying)
const API = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

type DocRow = {
  key: string;
  size: number;
  last_modified: string; // ISO
  url?: string;
};

type UploadState = "idle" | "uploading" | "done" | "error";
const DOC_TYPES = ["Tax Form", "Identification", "Direct Deposit Form"] as const;
type DocType = (typeof DOC_TYPES)[number];

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return `${(n / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Safe JSON reader: only tries JSON if the server actually sent JSON
async function safeJson(res: Response) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  throw new Error(text || `HTTP ${res.status}`);
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Upload form state
  const [employeeName, setEmployeeName] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<DocType[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMsg, setUploadMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      try {
        // best-effort sync; ignore failure
        await fetch(`${API}/documents/sync`, { method: "POST" }).catch(() => {});
        const res = await fetch(`${API}/documents`, { cache: "no-store" });
        if (!res.ok) throw new Error(`List failed (${res.status})`);
        const data = (await safeJson(res)) as DocRow[];
        if (!cancelled) setDocs(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? docs.filter(d => d.key?.toLowerCase().includes(q)) : docs;
  }, [docs, query]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`${API}/documents/sync`, { method: "POST" });
      if (!res.ok) throw new Error(`Sync failed (${res.status})`);
      const r = await fetch(`${API}/documents`, { cache: "no-store" });
      if (!r.ok) throw new Error(`Reload failed (${r.status})`);
      setDocs(await safeJson(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function toggleType(t: DocType) {
    setSelectedTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setUploadState("error"); setUploadMsg("Please choose a file."); return;
    }
    setUploadState("uploading"); setUploadMsg("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("employee_name", employeeName);
      form.append("doc_types", selectedTypes.join(","));

      const res = await fetch(`${API}/documents/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Upload failed (${res.status}) ${txt}`);
      }

      setUploadState("done");
      setUploadMsg("Uploaded!");
      setEmployeeName(""); setSelectedTypes([]); setFile(null);

      const r = await fetch(`${API}/documents`, { cache: "no-store" });
      if (r.ok) setDocs(await safeJson(r));
    } catch (err) {
      setUploadState("error");
      setUploadMsg(err instanceof Error ? err.message : "Upload failed");
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Employee Documents</h1>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-60"
        >
          {syncing ? "Syncing…" : "Sync with Bucket"}
        </button>
      </div>

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
                <td className="px-4 py-4 text-gray-500" colSpan={4}>No documents found.</td>
              </tr>
            ) : (
              filtered.map((d) => {
                const key = d.key ?? "";
                const viewUrl = `${API}/documents/${encodeURIComponent(key)}`;
                const downloadUrl = `${API}/documents/${encodeURIComponent(key)}?download=1`;
                return (
                  <tr key={key} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3"><div className="max-w-[520px] truncate">{key}</div></td>
                    <td className="px-4 py-3 whitespace-nowrap">{fmtBytes(Number(d.size))}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{fmtDate(d.last_modified)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <a className="rounded-md border border-gray-300 px-3 py-1 hover:bg-gray-100" href={viewUrl} target="_blank" rel="noreferrer">View</a>
                        <a className="rounded-md bg-gray-800 px-3 py-1 text-white hover:bg-black" href={downloadUrl}>Download</a>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

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
                    className={`rounded-full border px-3 py-1 text-sm ${active ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-700 hover:bg-gray-50"}`}
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
            <button type="submit" disabled={uploadState === "uploading"} className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-60">
              {uploadState === "uploading" ? "Uploading…" : "Upload"}
            </button>
            {uploadMsg && (
              <span className={`text-sm ${uploadState === "error" ? "text-red-600" : "text-gray-600"}`}>
                {uploadMsg}
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

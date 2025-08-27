'use client';

import React, { useEffect, useMemo, useState } from 'react';

type DocRow = {
  key: string;
  employee?: string | null;
  type?: string | null;
  size: number;
  uploaded: string; // ISO timestamp
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '') || ''; 
// If API_BASE is empty, the code will call relative paths (requires the rewrite in next.config.ts).

export default function DocumentsPage() {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // upload state
  const [employeeName, setEmployeeName] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);

  // search
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState('');

  // Format helpers
  const fmtSize = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
    return `${n} B`;
  };
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  const listUrl = useMemo(() => {
    const base = API_BASE || '';
    const qs = new URLSearchParams();
    if (query.trim()) qs.set('prefix', query.trim());
    qs.set('limit', '500');
    return `${base}/documents?${qs.toString()}`;
  }, [query]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(listUrl, { cache: 'no-store' });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${res.statusText} – ${text}`);
      }
      const data = (await res.json()) as { rows: DocRow[]; total: number };
      setRows(data.rows || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }

  async function syncBucket() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/documents/sync`, {
        method: 'POST',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${res.statusText} – ${text}`);
      }
      await load();
    } catch (e: any) {
      setError(e?.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      if (employeeName.trim()) form.append('employee', employeeName.trim());
      if (types.length) form.append('types', types.join(','));

      const res = await fetch(`${API_BASE}/documents/upload`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${res.statusText} – ${text}`);
      }
      // reset form & refresh list
      setFile(null);
      (document.getElementById('file-input') as HTMLInputElement)?.value && ((document.getElementById('file-input') as HTMLInputElement).value = '');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Upload failed');
    }
  }

  // Debounce search input -> real query
  useEffect(() => {
    const t = setTimeout(() => setQuery(typing), 350);
    return () => clearTimeout(t);
  }, [typing]);

  // Load on mount and when query changes
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUrl]);

  // Toggle a type checkbox
  function toggleType(v: string) {
    setTypes((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="text-3xl font-bold mb-4">Employee Documents</h1>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2">
          <button
            onClick={syncBucket}
            disabled={syncing}
            className="rounded-md bg-blue-600 px-3 py-2 text-white text-sm disabled:opacity-50"
            title="Scan R2 bucket and add any new files to the database"
          >
            {syncing ? 'Syncing…' : 'Sync with Bucket'}
          </button>
          <input
            placeholder="Search by file/employee/type…"
            className="rounded-md border px-3 py-2 text-sm w-72"
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
          />
        </div>
        {error && <div className="text-red-600 text-sm">{error}</div>}
      </div>

      {/* Upload card */}
      <form
        onSubmit={onUpload}
        className="mt-6 rounded-xl border bg-white p-4 shadow-sm"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <div className="mb-1 font-medium">Employee Name</div>
            <input
              className="w-full rounded-md border px-3 py-2"
              placeholder="e.g. Jane Doe"
              value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)}
            />
          </label>

          <div className="text-sm">
            <div className="mb-1 font-medium">Document Type(s)</div>
            <div className="flex flex-wrap gap-4 items-center">
              {['Tax Form', 'Identification', 'Direct Deposit Form'].map((t) => (
                <label key={t} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={types.includes(t)}
                    onChange={() => toggleType(t)}
                  />
                  <span>{t}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="text-sm">
            <div className="mb-1 font-medium">Upload File</div>
            <input
              id="file-input"
              type="file"
              accept="application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              className="rounded-md bg-green-600 px-4 py-2 text-white text-sm"
            >
              Upload
            </button>
          </div>
        </div>
      </form>

      {/* List */}
      <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-700">
            <tr>
              <th className="px-3 py-2 text-left">File</th>
              <th className="px-3 py-2 text-left">Employee</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Uploaded</th>
              <th className="px-3 py-2 text-left">Size</th>
              <th className="px-3 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-4 text-gray-500" colSpan={6}>
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-gray-500" colSpan={6}>
                  No documents found.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="px-3 py-2 font-medium break-all">{r.key}</td>
                <td className="px-3 py-2">{r.employee || '—'}</td>
                <td className="px-3 py-2">{r.type || '—'}</td>
                <td className="px-3 py-2">{fmtDate(r.uploaded)}</td>
                <td className="px-3 py-2">{fmtSize(r.size)}</td>
                <td className="px-3 py-2">
                  <a
                    className="text-blue-600 hover:underline"
                    href={`${API_BASE}/documents/file/${encodeURIComponent(r.key)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View / Download
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-gray-500">
        Backend base: <code>{API_BASE || '(relative via Next.js rewrite)'}</code>
      </p>
    </div>
  );
}

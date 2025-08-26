"use client";

import React, { useEffect, useMemo, useState } from "react";

type DocRow = {
  id: number;
  key: string;
  employee_name?: string | null;
  employee_id?: string | null;
  doc_types?: string | null;   // comma separated
  size?: number | null;
  content_type?: string | null;
  uploaded_at?: string | null;
};

const API = process.env.NEXT_PUBLIC_API_BASE; // e.g. https://yho-stack.onrender.com

export default function DocumentsPage() {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // upload form
  const [empName, setEmpName] = useState("");
  const [empId, setEmpId] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);

  const tags = ["tax", "id", "deposit", "w4", "i9"];

  async function syncAndLoad(query?: string) {
    setLoading(true);
    setErr(null);
    try {
      // 1) sync from R2→DB (idempotent)
      await fetch(`${API}/documents/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}) // optionally { prefix: "employees/" }
      });

      // 2) fetch list
      const res = await fetch(`${API}/documents${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRows(data.rows || []);
    } catch (e: any) {
      console.error(e);
      setErr(e.message || "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    syncAndLoad();
  }, []);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    await syncAndLoad(q);
  }

  async function onDownload(key: string) {
    try {
      const res = await fetch(`${API}/documents/presign/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      window.open(data.url, "_blank");
    } catch (e) {
      alert("Download failed");
    }
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      alert("Choose a file first");
      return;
    }

    try {
      // 1) presign PUT
      const presign = await fetch(`${API}/documents/presign/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          content_type: file.type || "application/octet-stream",
        }),
      });
      if (!presign.ok) throw new Error(await presign.text());
      const { key, url } = await presign.json();

      // 2) upload to R2
      const put = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`PUT failed: ${put.status}`);

      // 3) save metadata in DB
      const save = await fetch(`${API}/documents/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          employee_name: empName || null,
          employee_id: empId || null,
          doc_types: types,
          size: file.size,
          content_type: file.type || "application/octet-stream",
        }),
      });
      if (!save.ok) throw new Error(await save.text());

      // 4) reload list
      setEmpName("");
      setEmpId("");
      setTypes([]);
      setFile(null);
      (document.getElementById("file-input") as HTMLInputElement | null)?.value && ((document.getElementById("file-input") as HTMLInputElement).value = "");
      await syncAndLoad(q);
      alert("Uploaded!");
    } catch (e: any) {
      console.error(e);
      alert(e.message || "Upload failed");
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontWeight: 700, marginBottom: 12 }}>Employee Documents</h1>

      <form onSubmit={onSearch} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by filename, employee name, or tags…"
          style={{ flex: 1, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 8 }}
        />
        <button
          type="submit"
          style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#111827", color: "#fff" }}
        >
          {loading ? "Loading…" : "Search"}
        </button>
      </form>

      {err && (
        <div style={{ background: "#fee2e2", border: "1px solid #fecaca", padding: 10, borderRadius: 8, marginBottom: 12 }}>
          {err}
        </div>
      )}

      <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
          <thead style={{ background: "#f3f4f6" }}>
            <tr>
              <th style={th}>Key</th>
              <th style={th}>Employee</th>
              <th style={th}>Tags</th>
              <th style={th}>Size</th>
              <th style={th}>Uploaded</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td} title={r.key}>{r.key}</td>
                <td style={td}>{r.employee_name || ""}</td>
                <td style={td}>{r.doc_types || ""}</td>
                <td style={td}>{r.size ? niceBytes(r.size) : ""}</td>
                <td style={td}>{r.uploaded_at ? new Date(r.uploaded_at).toLocaleString() : ""}</td>
                <td style={tdRight}>
                  <button onClick={() => onDownload(r.key)} style={btn}>Download</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 16, textAlign: "center", color: "#6b7280" }}>No documents</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontWeight: 700, marginBottom: 10 }}>Upload</h2>
      <form onSubmit={onUpload} style={{ display: "grid", gap: 10, maxWidth: 700 }}>
        <input
          value={empName}
          onChange={(e) => setEmpName(e.target.value)}
          placeholder="Employee name (optional)"
          style={input}
        />
        <input
          value={empId}
          onChange={(e) => setEmpId(e.target.value)}
          placeholder="Employee ID (optional)"
          style={input}
        />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tags.map((t) => {
            const on = types.includes(t);
            return (
              <label key={t} style={{ display: "inline-flex", gap: 6, alignItems: "center", padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 999, background: on ? "#e0e7ff" : "#fff" }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    if (e.target.checked) setTypes((p) => [...p, t]);
                    else setTypes((p) => p.filter((x) => x !== t));
                  }}
                />
                {t}
              </label>
            );
          })}
        </div>

        <input id="file-input" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <button type="submit" style={{ ...btn, alignSelf: "start", background: "#111827", color: "#fff" }}>Upload</button>
      </form>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 13, color: "#374151", borderBottom: "1px solid #e5e7eb" };
const td: React.CSSProperties = { padding: "10px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13, color: "#111827", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const tdRight: React.CSSProperties = { ...td, textAlign: "right" };
const btn: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff" };
const input: React.CSSProperties = { padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 8 };

function niceBytes(x: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let l = 0, n = x;
  while (n >= 1024 && ++l) n = n / 1024;
  return `${n.toFixed(n < 10 && l > 0 ? 1 : 0)} ${units[l]}`;
}

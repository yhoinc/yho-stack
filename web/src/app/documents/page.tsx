"use client";

import React, { useEffect, useMemo, useState } from "react";

const API =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, "") || "http://localhost:8000";

type DocRow = {
  id: number;
  employee_id: string | null;
  employee_name: string;
  doc_types: string; // comma-separated
  object_key: string;
  content_type: string | null;
  size: number | null;
  uploaded_at: string;
};

function fmtBytes(n?: number | null) {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function DocumentsPage() {
  // Upload form state
  const [employeeName, setEmployeeName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [docTax, setDocTax] = useState(false);
  const [docId, setDocId] = useState(false);
  const [docDeposit, setDocDeposit] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Search state
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<DocRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const docTypes = useMemo(() => {
    const arr: string[] = [];
    if (docTax) arr.push("tax");
    if (docId) arr.push("id");
    if (docDeposit) arr.push("deposit");
    return arr;
  }, [docTax, docId, docDeposit]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setError(null);

    if (!file) {
      setError("Please choose a file.");
      return;
    }
    if (!employeeName.trim()) {
      setError("Employee name is required.");
      return;
    }

    try {
      setUploading(true);

      // 1) Ask API for presigned PUT
      const presignRes = await fetch(`${API}/documents/presign-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_name: employeeName.trim(),
          employee_id: employeeId.trim() || null,
          doc_types: docTypes,
          filename: file.name,
          content_type: file.type || "application/octet-stream",
        }),
      });
      if (!presignRes.ok) throw new Error(await presignRes.text());
      const presigned = await presignRes.json() as {
        key: string;
        upload_url: string;
        headers?: Record<string, string>;
      };

      // 2) Upload directly to R2
      const putHeaders = new Headers(presigned.headers || {});
      if (!putHeaders.has("Content-Type") && file.type) {
        putHeaders.set("Content-Type", file.type);
      }
      const putRes = await fetch(presigned.upload_url, {
        method: "PUT",
        headers: putHeaders,
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText}`);

      // 3) Tell API to save metadata
      const saveRes = await fetch(`${API}/documents/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: presigned.key,
          employee_name: employeeName.trim(),
          employee_id: employeeId.trim() || null,
          doc_types: docTypes,
          size: file.size,
          content_type: file.type || "application/octet-stream",
        }),
      });
      if (!saveRes.ok) throw new Error(await saveRes.text());
      const saved = await saveRes.json();

      setMessage(`Uploaded ✓ (doc id ${saved.id})`);
      setFile(null);
      // light reset
      setRefreshTick((x) => x + 1); // refresh list
    } catch (err: any) {
      setError(err?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function loadList() {
    setLoadingList(true);
    setError(null);
    try {
      const url = new URL(`${API}/documents/search`);
      if (q.trim()) url.searchParams.set("q", q.trim());
      url.searchParams.set("limit", "50");
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRows(data.rows || []);
    } catch (err: any) {
      setError(err?.message || "Failed to load documents");
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  async function downloadDoc(id: number) {
    try {
      const res = await fetch(`${API}/documents/${id}/download`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.url) window.open(data.url, "_blank");
    } catch (err: any) {
      setError(err?.message || "Unable to open document");
    }
  }

  async function deleteDoc(id: number) {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    try {
      const res = await fetch(`${API}/documents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err: any) {
      setError(err?.message || "Delete failed");
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Documents</h1>
      <p style={{ color: "#555", marginBottom: 24 }}>
        Upload employee documents to Cloudflare R2 and search / download them.
      </p>

      {/* Upload Card */}
      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 16,
          marginBottom: 28,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Upload</h2>

        <form onSubmit={handleUpload} style={{ display: "grid", gap: 12 }}>
          <div>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>
              Employee Name
            </label>
            <input
              value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)}
              placeholder="e.g. Ana Gomez"
              required
              style={{
                width: "100%",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                padding: "10px 12px",
              }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>
              Employee ID (optional)
            </label>
            <input
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder="e.g. EMP0083"
              style={{
                width: "100%",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                padding: "10px 12px",
              }}
            />
          </div>

          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Document Type(s)</div>
            <label style={{ marginRight: 16 }}>
              <input
                type="checkbox"
                checked={docTax}
                onChange={(e) => setDocTax(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Tax Form
            </label>
            <label style={{ marginRight: 16 }}>
              <input
                type="checkbox"
                checked={docId}
                onChange={(e) => setDocId(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Identification
            </label>
            <label>
              <input
                type="checkbox"
                checked={docDeposit}
                onChange={(e) => setDocDeposit(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Direct Deposit Form
            </label>
          </div>

          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>File</div>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              type="submit"
              disabled={uploading}
              style={{
                background: "#111827",
                color: "white",
                fontWeight: 600,
                borderRadius: 8,
                padding: "10px 14px",
                border: "none",
                cursor: "pointer",
                opacity: uploading ? 0.7 : 1,
              }}
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
            {message && <span style={{ color: "#065f46" }}>{message}</span>}
            {error && <span style={{ color: "#b91c1c" }}>{error}</span>}
          </div>
        </form>
      </section>

      {/* Search / List */}
      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 16,
          background: "#fff",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, type, or key…"
            style={{
              flex: "1 1 240px",
              minWidth: 220,
              border: "1px solid #d1d5db",
              borderRadius: 8,
              padding: "10px 12px",
            }}
          />
          <button
            onClick={loadList}
            disabled={loadingList}
            style={{
              background: "#2563eb",
              color: "white",
              fontWeight: 600,
              borderRadius: 8,
              padding: "10px 14px",
              border: "none",
              cursor: "pointer",
              opacity: loadingList ? 0.7 : 1,
            }}
          >
            {loadingList ? "Searching…" : "Search"}
          </button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ padding: "8px 6px" }}>Employee</th>
                <th style={{ padding: "8px 6px" }}>Types</th>
                <th style={{ padding: "8px 6px" }}>Size</th>
                <th style={{ padding: "8px 6px" }}>Uploaded</th>
                <th style={{ padding: "8px 6px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                    <div style={{ fontWeight: 600 }}>{r.employee_name}</div>
                    <div style={{ color: "#6b7280", fontSize: 12 }}>{r.employee_id || "—"}</div>
                  </td>
                  <td style={{ padding: "8px 6px" }}>{r.doc_types || "—"}</td>
                  <td style={{ padding: "8px 6px" }}>{fmtBytes(r.size)}</td>
                  <td style={{ padding: "8px 6px" }}>{fmtDate(r.uploaded_at)}</td>
                  <td style={{ padding: "8px 6px" }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={() => downloadDoc(r.id)}
                        style={{
                          background: "#111827",
                          color: "#fff",
                          borderRadius: 6,
                          padding: "6px 10px",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        Open
                      </button>
                      <button
                        onClick={() => deleteDoc(r.id)}
                        style={{
                          background: "#dc2626",
                          color: "#fff",
                          borderRadius: 6,
                          padding: "6px 10px",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                    <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>
                      <span title={r.object_key}>{r.object_key}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loadingList && (
                <tr>
                  <td colSpan={5} style={{ padding: 12, color: "#6b7280" }}>
                    No documents found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

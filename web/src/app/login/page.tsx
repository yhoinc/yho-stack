// web/src/app/login/page.tsx
"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Box, Button, Paper, Stack, TextField, Typography,
} from "@mui/material";

function InnerLogin() {
  const search = useSearchParams();
  const router = useRouter();
  const next = search.get("next") || "/";

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "Login failed");
      router.push(next);
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: "100dvh", display: "grid", placeItems: "center", p: 2 }}>
      <Paper elevation={3} sx={{ p: 3, width: 360 }}>
        <Typography variant="h6" fontWeight={700} gutterBottom>
          Sign in
        </Typography>
        <form onSubmit={submit}>
          <Stack gap={2}>
            <TextField
              label="Username"
              value={username}
              autoFocus
              onChange={(e) => setUsername(e.target.value)}
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <Typography color="error">{error}</Typography>}
            <Button type="submit" variant="contained" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </Button>
          </Stack>
        </form>
        <Box sx={{ mt: 2 }}>
          <Typography variant="body2" color="text.secondary">
            admin / admin — full access<br />
            danny / Yho — employees, documents<br />
            heejung / Yho — employees, documents
          </Typography>
        </Box>
      </Paper>
    </Box>
  );
}

export default function LoginPage() {
  // Satisfy Next warning about useSearchParams during prerender
  return (
    <Suspense>
      <InnerLogin />
    </Suspense>
  );
}

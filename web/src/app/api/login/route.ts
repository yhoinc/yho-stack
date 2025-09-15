"use client";

import * as React from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

function LoginInner() {
  const router = useRouter();
  const sp = useSearchParams(); // ok because wrapped in <Suspense/>
  const msg = sp.get("msg") || "";

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.ok !== true) {
        throw new Error(data?.error || "Invalid credentials");
      }
      // go home; middleware will let the user through based on cookie
      router.replace("/");
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        p: 2,
        bgcolor: "background.default",
      }}
    >
      <Paper elevation={3} sx={{ p: 3, width: "100%", maxWidth: 420 }}>
        <Stack gap={2}>
          <Typography variant="h5" fontWeight={700}>
            Sign in
          </Typography>

          {msg && <Alert severity="info">{msg}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}

          <form onSubmit={onSubmit}>
            <Stack gap={2}>
              <TextField
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                autoFocus
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Button
                type="submit"
                variant="contained"
                disabled={submitting}
              >
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </Stack>
          </form>
        </Stack>
      </Paper>
    </Box>
  );
}

export default function LoginPage() {
  // Wrap the component that calls useSearchParams in Suspense.
  return (
    <Suspense fallback={<div />}>
      <LoginInner />
    </Suspense>
  );
}

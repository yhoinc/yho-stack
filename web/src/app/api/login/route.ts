// web/src/app/login/page.tsx
"use client";

import * as React from "react";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
  Alert,
} from "@mui/material";

function LoginInner() {
  const router = useRouter();
  const search = useSearchParams(); // must be inside Suspense
  const from = search?.get("from") || "/employees";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const t = await res.json().catch(() => ({}));
        throw new Error(t?.error || "Login failed");
      }
      // Cookie is set by the API route; just navigate.
      router.replace(from || "/");
    } catch (e: any) {
      setErr(e?.message || "Login failed");
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
      <Card sx={{ width: 380, maxWidth: "100%", borderRadius: 3, boxShadow: 3 }}>
        <CardContent>
          <Stack gap={2} component="form" onSubmit={onSubmit}>
            <Typography variant="h5" fontWeight={700} textAlign="center">
              Sign in
            </Typography>
            {err && <Alert severity="error">{err}</Alert>}
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={submitting}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div />}>
      <LoginInner />
    </Suspense>
  );
}

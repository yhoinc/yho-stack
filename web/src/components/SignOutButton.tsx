"use client";
import * as React from "react";
import { Button } from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";

export function SignOutButton() {
  const onClick = async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  };
  return (
    <Button onClick={onClick} startIcon={<LogoutIcon />} color="inherit">
      Sign out
    </Button>
  );
}

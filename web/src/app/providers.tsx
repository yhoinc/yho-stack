"use client";

import * as React from "react";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";

const theme = createTheme({
    palette: {
        mode: "light",
        primary: { main: "#2563eb" },        // blue-600
        secondary: { main: "#0ea5e9" },      // sky-500
        background: { default: "#f7f8fb", paper: "#ffffff" },
        grey: { 100: "#f3f4f6", 200: "#e5e7eb", 300: "#d1d5db" },
    },
    shape: { borderRadius: 10 },
    components: {
        MuiButton: { styleOverrides: { root: { textTransform: "none", borderRadius: 10 } } },
        MuiPaper: { styleOverrides: { root: { borderRadius: 12 } } },

    },
    typography: { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system' },
});

export default function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {children}
        </ThemeProvider>
    );
}
import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";
import Link from "next/link";

export const metadata: Metadata = { title: "YHO Admin", description: "Ops dashboard" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                <Providers>
                    <header style={{ background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
                        <div
                            style={{
                                maxWidth: 1200,
                                margin: "0 auto",
                                padding: "12px 16px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                            }}
                        >
                            <div style={{ fontWeight: 700 }}>YHO Admin</div>
                            <nav style={{ display: "flex", gap: 16 }}>
                                <Link href="/employees">Employees</Link>
                                <Link href="/payroll">Payroll</Link>
                                <Link href="/reports">Reports</Link>
                                <Link href="/documents">Documents</Link>
                            </nav>
                        </div>
                    </header>
                    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
                        {children}
                    </main>
                </Providers>
            </body>
        </html>
    );
}

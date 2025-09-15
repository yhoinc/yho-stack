"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { canAccess, type UserRole } from "@/lib/rbac";

export default function Nav() {
  const [role, setRole] = useState<UserRole | null>(null);

  useEffect(() => {
    // session is in a cookie; quick ping to /api/me (if you have it)
    // or parse a role you expose on the page somewhere.
    // For now, we’ll leave it null (middleware already protects).
  }, []);

  const items = [
    { href: "/employees", label: "Employees" },
    { href: "/documents", label: "Documents" },
    { href: "/payroll", label: "Payroll" },
    { href: "/reports", label: "Reports" },
  ];

  return (
    <nav style={{display:"flex",gap:12}}>
      {items.map((i) => {
        // If we don’t know the role yet, show nothing; middleware still enforces.
        if (!role) return null;
        if (!canAccess(i.href, role)) return null;
        return <Link key={i.href} href={i.href}>{i.label}</Link>;
      })}
      <form action="/api/logout" method="post"><button>Sign out</button></form>
    </nav>
  );
}

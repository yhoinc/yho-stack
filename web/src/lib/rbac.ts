// web/src/lib/rbac.ts
export type UserRole = "admin" | "danny" | "heejung";

type AccessMap = {
  [K in UserRole]: ReadonlyArray<string>; // allowed route prefixes
};

// Define which top-level sections each role can open.
// Use route prefixes; everything under those prefixes is allowed.
export const ROUTE_ACCESS: AccessMap = {
  admin: ["/", "/employees", "/documents", "/payroll", "/reports", "/login", "/api"],
  danny: ["/", "/employees", "/documents", "/login", "/api"],
  heejung: ["/", "/employees", "/documents", "/login", "/api"],
};

export function canAccess(pathname: string, role: UserRole): boolean {
  const allowed = ROUTE_ACCESS[role] ?? [];
  return allowed.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
}

// If you want a default landing page per role:
export function defaultRouteFor(role: UserRole): string {
  switch (role) {
    case "admin": return "/employees";
    case "danny": return "/employees";
    case "heejung": return "/employees";
    default: return "/login";
  }
}

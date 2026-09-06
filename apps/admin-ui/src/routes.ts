export type View =
  | "platform-home"
  | "inbox"
  | "activity"
  | "qasey-overview"
  | "qasey-runs"
  | "qasey-cases"
  | "qasey-review"
  | "triggers"
  | "access";

export const adminPaths = {
  "platform-home": "/admin",
  inbox: "/admin/inbox",
  activity: "/admin/activity",
  "qasey-overview": "/admin/apps/qasey",
  "qasey-runs": "/admin/apps/qasey/runs",
  "qasey-cases": "/admin/apps/qasey/cases",
  "qasey-review": "/admin/apps/qasey/reviews",
  triggers: "/admin/triggers",
  access: "/admin/access",
} as const satisfies Record<View, string>;

const viewsByPath = new Map<string, View>(
  Object.entries(adminPaths).map(([view, path]) => [path, view as View]),
);

export function viewForAdminPath(pathname: string): View | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  return viewsByPath.get(normalized);
}

export function legacyAdminPath(pathname: string, hash: string): string | undefined {
  if (pathname === "/admin" && hash === "#apps/qasey") return adminPaths["qasey-overview"];
  return undefined;
}

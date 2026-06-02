import type { SupabaseClient } from "@supabase/supabase-js";

// Tiny hash-based router. Pages register themselves in a table so adding a route
// (e.g. #12's history page) means editing the route table here ONCE — never main.ts.
// The history route is already wired below to a stub.

export type RouteHandler = (root: HTMLElement, client: SupabaseClient) => void | Promise<void>;

const routes = new Map<string, RouteHandler>();

export function registerRoute(path: string, handler: RouteHandler): void {
  routes.set(path, handler);
}

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash || "/";
}

export function startRouter(root: HTMLElement, client: SupabaseClient): void {
  const dispatch = () => {
    const path = currentPath();
    const handler = routes.get(path) ?? routes.get("/");
    if (handler) void handler(root, client);
  };
  window.addEventListener("hashchange", dispatch);
  dispatch();
}

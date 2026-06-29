// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAppNav } from "../../src/views/app-nav";

const stubClient = { auth: { signOut: async () => ({}) } } as unknown as SupabaseClient;

const ALL_HREFS = ["#/", "#/history", "#/logs", "#/source-health", "#/token-usage"] as const;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("buildAppNav — structure", () => {
  it("renders exactly 5 <a> links in the nav", () => {
    const nav = buildAppNav(stubClient, "#/");
    document.body.appendChild(nav);
    const links = nav.querySelectorAll("a");
    expect(links.length).toBe(5);
  });

  it("renders links in canonical order: #/, #/history, #/logs, #/source-health, #/token-usage", () => {
    const nav = buildAppNav(stubClient, "#/");
    document.body.appendChild(nav);
    const hrefs = Array.from(nav.querySelectorAll<HTMLAnchorElement>("a")).map(
      (a) => a.getAttribute("href"),
    );
    expect(hrefs).toEqual([...ALL_HREFS]);
  });

  it("contains a sign-out button with class sign-out", () => {
    const nav = buildAppNav(stubClient, "#/");
    document.body.appendChild(nav);
    const btn = nav.querySelector(".sign-out");
    expect(btn).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// aria-current per active route — regression: active link must appear in DOM
// ---------------------------------------------------------------------------

describe.each(ALL_HREFS.map((href) => ({ activeHref: href })))(
  "buildAppNav — active route $activeHref",
  ({ activeHref }) => {
    it("exactly one <a> has aria-current='page'", () => {
      const nav = buildAppNav(stubClient, activeHref);
      document.body.appendChild(nav);
      const active = nav.querySelectorAll<HTMLAnchorElement>("a[aria-current='page']");
      expect(active.length).toBe(1);
    });

    it("the active <a> href matches activeHref", () => {
      const nav = buildAppNav(stubClient, activeHref);
      document.body.appendChild(nav);
      const active = nav.querySelector<HTMLAnchorElement>("a[aria-current='page']");
      expect(active).not.toBeNull();
      expect(active!.getAttribute("href")).toBe(activeHref);
    });

    it("the active link IS present in the DOM (regression: old code omitted it)", () => {
      const nav = buildAppNav(stubClient, activeHref);
      document.body.appendChild(nav);
      const link = nav.querySelector<HTMLAnchorElement>(`a[href="${activeHref}"]`);
      expect(link).not.toBeNull();
    });

    it("all other 4 links have no aria-current attribute", () => {
      const nav = buildAppNav(stubClient, activeHref);
      document.body.appendChild(nav);
      const others = Array.from(
        nav.querySelectorAll<HTMLAnchorElement>("a"),
      ).filter((a) => a.getAttribute("href") !== activeHref);
      expect(others.length).toBe(4);
      for (const a of others) {
        expect(a.hasAttribute("aria-current")).toBe(false);
      }
    });
  },
);

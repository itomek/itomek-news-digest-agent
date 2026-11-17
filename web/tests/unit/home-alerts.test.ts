// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderHome } from "../../src/pages/home";
import { appToday } from "../../src/lib/dates";
import { fetchAgentAlerts, fetchDigests, fetchMissedDigests, fetchTopics } from "../../src/lib/supabase";
import { isAuthenticatedAtRequiredLevel } from "../../src/lib/auth";
import { registerPlaybackControls } from "../../src/views/digest-card";
import type { AgentAlert, Digest } from "../../src/lib/types";
vi.mock("../../src/lib/supabase", async (original) => ({ ...await original<typeof import("../../src/lib/supabase")>(), fetchAgentAlerts: vi.fn(), fetchDigests: vi.fn(), fetchTopics: vi.fn(), fetchMissedDigests: vi.fn() }));
vi.mock("../../src/lib/auth", async (original) => ({ ...await original<typeof import("../../src/lib/auth")>(), isAuthenticatedAtRequiredLevel: vi.fn() }));
vi.mock("../../src/views/auth-gate", () => ({ renderAuthGate: (root: HTMLElement) => { root.textContent = "Sign in"; } }));
const client = { auth: { signOut: async () => ({}) } } as unknown as SupabaseClient;
const alert: AgentAlert = { code: "accounting_uncertain", message: "A model request has unresolved billing.", changedAt: "2026-11-17T18:00:00Z", affectedCount: 2 };
let root: HTMLElement, reads: number;
beforeEach(() => {
  vi.clearAllMocks(); reads = 0; document.body.replaceChildren(); root = document.createElement("div"); document.body.appendChild(root);
  vi.mocked(isAuthenticatedAtRequiredLevel).mockResolvedValue(true);
  const digest: Digest = { id: "today-news", topic_slug: "ai_models", content: "A practical new model release.", cadence: "24h", digest_date: appToday(), sources_used: [], token_count: null, prompt_version: "v", created_at: new Date().toISOString(), summary: null, items: null };
  vi.mocked(fetchDigests).mockResolvedValue([digest]); vi.mocked(fetchTopics).mockResolvedValue([]); vi.mocked(fetchMissedDigests).mockResolvedValue([]); vi.mocked(fetchAgentAlerts).mockResolvedValue([]);
  registerPlaybackControls((slot) => { const button = document.createElement("button"); button.textContent = "Read digest"; button.addEventListener("click", () => { reads++; }); slot.appendChild(button); });
});
function expectReaderWorks() {
  expect(root.textContent).toContain("A practical new model release.");
  const button = root.querySelector<HTMLButtonElement>(".playback-slot button"); expect(button).not.toBeNull(); button!.click(); expect(reads).toBe(1);
}
describe("home news agent alerts", () => {
  it("keeps quiet when there are no active alerts and preserves reader controls", async () => {
    await renderHome(root, client); expect(root.querySelector('[data-testid="agent-alert-banner"]')).toBeNull(); expect(root.querySelector('[data-testid="agent-status-unavailable"]')).toBeNull(); expectReaderWorks();
  });
  it("renders friendly active messages using existing banner styles without machine-code copy", async () => {
    vi.mocked(fetchAgentAlerts).mockResolvedValue([alert]); await renderHome(root, client);
    const banner = root.querySelector('[data-testid="agent-alert-banner"]'); expect(banner?.className).toBe("missed-digest-banner"); expect(banner?.textContent).toContain("News agent alerts"); expect(banner?.textContent).toContain(alert.message); expect(banner?.textContent).toContain("2 affected"); expect(banner?.textContent).not.toContain(alert.code); expectReaderWorks();
  });
  it("escapes returned text and never renders raw status errors", async () => {
    vi.mocked(fetchAgentAlerts).mockResolvedValue([{ ...alert, message: '<img src=x onerror="alert(1)">' }]); await renderHome(root, client); expect(root.querySelector("img")).toBeNull(); expect(root.textContent).toContain("<img");
    vi.mocked(fetchAgentAlerts).mockRejectedValue(new Error("PRIVATE ACCESS TOKEN <script>")); await renderHome(root, client); await Promise.resolve();
    expect(root.querySelector('[data-testid="agent-status-unavailable"]')?.textContent).toBe("News agent status unavailable"); expect(root.textContent).not.toContain("PRIVATE"); expect(root.querySelector("script")).toBeNull(); expectReaderWorks();
  });
  it("does not wait for alert status to load digests or mount playback", async () => {
    let finish!: (alerts: AgentAlert[]) => void; vi.mocked(fetchAgentAlerts).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await renderHome(root, client); expectReaderWorks(); finish([alert]); await Promise.resolve(); expect(root.querySelector('[data-testid="agent-alert-banner"]')).not.toBeNull();
  });
  it("does not request alerts before the existing authentication gate passes", async () => {
    vi.mocked(isAuthenticatedAtRequiredLevel).mockResolvedValue(false); await renderHome(root, client); expect(fetchAgentAlerts).not.toHaveBeenCalled(); expect(fetchDigests).not.toHaveBeenCalled(); expect(root.textContent).toBe("Sign in");
  });
});

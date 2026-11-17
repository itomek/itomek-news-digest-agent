import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAgentAlerts } from "../../src/lib/supabase";
const row = { code: "source_failed", message: "A news source could not be refreshed.", changedAt: "2026-11-17T18:00:00Z", affectedCount: 1 };
function fixture(data: unknown, error: unknown = null) {
  const abortSignal = vi.fn(async (signal: AbortSignal) => { expect(signal).toBeInstanceOf(AbortSignal); return { data, error }; });
  const rpc = vi.fn(() => ({ abortSignal })); return { client: { rpc } as unknown as SupabaseClient, rpc, abortSignal };
}
describe("authenticated agent alert RPC", () => {
  it("calls only the fixed no-argument RPC on the existing browser client", async () => {
    const f = fixture([row]); expect(await fetchAgentAlerts(f.client)).toEqual([row]); expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.rpc).toHaveBeenCalledWith("warpcore_agent_active_alerts"); expect(f.abortSignal).toHaveBeenCalledTimes(1);
  });
  it("accepts no active alerts and rejects an unavailable RPC", async () => {
    expect(await fetchAgentAlerts(fixture([]).client)).toEqual([]); await expect(fetchAgentAlerts(fixture(null, new Error("RPC unavailable")).client)).rejects.toThrow("RPC unavailable");
  });
  it("rejects oversized, malformed or opaque operator data", async () => {
    for (const data of [null, {}, Array(16).fill(row), [{ ...row, privateKey: "must not render" }], [{ ...row, message: null }], [{ ...row, changedAt: "bad" }], [{ ...row, affectedCount: -1 }]]) await expect(fetchAgentAlerts(fixture(data).client)).rejects.toThrow("Invalid agent status");
  });
});

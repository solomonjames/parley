// Drives `parley test-drive` against a mock Messages API: the loop, tool routing, auto-commit
// and the consent path (no TTY → not approved) all run for real; only the model is scripted.
import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { testDrive } from "../src/testdrive.js";

const day = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
const script = [
  { type: "tool_use", id: "t1", name: "parley_intent", input: { service: "calendar.example", capability: "calendar.reschedule", params: { event: "e2", day: day(3) }, auto: true } },
  { type: "tool_use", id: "t2", name: "parley_intent", input: { service: "shop.example", capability: "shop.order", params: { items: [{ sku: "m005", qty: 2 }, { sku: "m007", qty: 2 }], deliver: day(2) } } },
  { type: "tool_use", id: "t3", name: "parley_commit", input: { service: "shop.example", proposal: "__FIRST_PROPOSAL__" } },
  { type: "text", text: "Moved your 1:1. The order needs your approval." },
];
const requests: any[] = [];
let lastToolText = "";
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const r = JSON.parse(body);
  requests.push({ headers: req.headers, body: r });
  const last = r.messages.at(-1);
  if (Array.isArray(last.content)) lastToolText = last.content.map((b: any) => b.content).join("\n");
  const step = script[requests.length - 1];
  let block: any = step;
  if (step.type === "tool_use" && step.input.proposal === "__FIRST_PROPOSAL__") block = { ...step, input: { ...step.input, proposal: /\[(p_[^\]]+)\]/.exec(lastToolText)![1] } };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    id: `msg_${requests.length}`, type: "message", role: "assistant", model: r.model,
    content: [block], stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
afterAll(() => server.close());

describe("parley test-drive", () => {
  it("runs a full tool loop against the Messages API with fallbacks on", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      await testDrive({ prompt: "do the thing" });
    } finally {
      console.log = orig;
    }
    const out = logs.join("\n");
    expect(requests).toHaveLength(4);
    expect(requests[0].body.model).toBe("claude-opus-5");
    expect(requests[0].body.fallbacks).toBe("default");
    expect(String(requests[0].headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(requests[0].body.tools.map((t: any) => t.name)).toEqual(["parley_ask", "parley_intent", "parley_commit", "parley_undo"]);
    expect(out).toMatch(/✓ Move "1:1 with Ana"/); // auto-committed within policy
    expect(out).toMatch(/approve this exact action|are asked to approve/); // consent routed to the human
    expect(lastToolText).toContain("consent_required");
    expect(out).toContain("Moved your 1:1");
  });
});

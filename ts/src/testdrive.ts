/**
 * `parley test-drive`: watch a real Claude model use Parley, live, in your terminal.
 * The example calendar and shop run in-process; the model gets the same four tools as the
 * MCP bridge; anything outside the (throwaway) policy asks YOU to approve it.
 * Needs an Anthropic API key (ANTHROPIC_API_KEY or an `ant auth login` profile).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { Client, local } from "./client.js";
import { keyPair } from "./crypto.js";
import { calendar } from "./examples/calendar.js";
import { shop } from "./examples/shop.js";
import { issueGrant } from "./grants.js";
import { est } from "./lens.js";
import { TOOLS, createToolHost } from "./tools.js";

const c = { dim: "\x1b[2m", b: "\x1b[1m", cyan: "\x1b[36m", mag: "\x1b[35m", yel: "\x1b[33m", grn: "\x1b[32m", red: "\x1b[31m", x: "\x1b[0m" };
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const k = (s: string, code: string) => (color ? code + s + c.x : s);
const indent = (s: string) => s.split("\n").map((l) => "   " + k("│ ", c.dim) + l).join("\n");

const day = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
export const DEFAULT_PROMPT = () =>
  `Move my 1:1 with Ana to a free slot on ${day(3)}. Then order me 4 vegan meals under 700 calories (2 each of two different meals) for delivery on ${day(2)}. Tell me exactly what happened.`;

/** Models that accept the server-side `fallbacks: "default"` chain. */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);

export async function testDrive(o: { model?: string; prompt?: string; maxTurns?: number } = {}) {
  const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
  const model = o.model ?? "claude-opus-5";
  const prompt = o.prompt ?? DEFAULT_PROMPT();

  // A throwaway identity and policy, so the test drive never touches ~/.parley.
  process.env.PARLEY_HOME = mkdtempSync(join(tmpdir(), "parley-test-drive-"));
  const you = await keyPair(), agent = await keyPair();
  writeFileSync(join(process.env.PARLEY_HOME, "principal.key"), you.seed);
  const grant = await issueGrant({ principal: you, to: agent.public, caveats: [{ risk: "low" }, { per: { max: 4000, currency: "USD" } }, { spend: { max: 10000, currency: "USD" } }, { exp: Math.floor(Date.now() / 1000) + 3600 }] });
  const clients = [calendar({ trust: [you.public] }), shop({ trust: [you.public] })].map((s) => new Client(local(s), { key: agent.seed, grants: [grant] }));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const host = await createToolHost(clients, async ({ service, shown, reason }) => {
    console.log(`\n${k("👤 you", c.yel)} are asked to approve, at ${service}:\n${indent(shown)}\n   ${k(reason, c.dim)}`);
    if (!process.stdin.isTTY) return false;
    return /^y/i.test(await rl.question(k("   approve this exact action? [y/N] › ", c.yel)));
  });

  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema }));
  const system = `You are an assistant acting on behalf of the user through Parley services. Your policy (signed by the user): low-risk actions only, up to 40.00 USD per action and 100.00 USD total. Anything beyond it is sent to the user for approval automatically. Never try to work around a limit.\n\n${host.instructions}`;

  console.log(k(`\nParley test drive · ${model} · two example services, your policy: low risk, ≤ 40 USD per action, ≤ 100 USD total\n`, c.b));
  console.log(`${k("👤 you:", c.yel)} ${prompt}`);

  const client = new AnthropicSDK();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  let toolTokens = 0, calls = 0, inTok = 0, outTok = 0;
  try {
    for (let turn = 0; turn < (o.maxTurns ?? 20); turn++) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system,
        tools,
        messages,
        ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      inTok += response.usage.input_tokens;
      outTok += response.usage.output_tokens;
      for (const b of response.content) if (b.type === "text" && b.text.trim()) console.log(`\n${k("🤖 " + response.model + ":", c.mag)} ${b.text.trim()}`);
      if (response.stop_reason === "refusal") {
        console.log(k("\n(the model declined this request)", c.red));
        break;
      }
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!uses.length || response.stop_reason === "end_turn") break;
      if (response.stop_reason === "max_tokens") throw new Error("the model's tool input was cut off (max_tokens)");
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const args = (u.input ?? {}) as Record<string, unknown>;
        const { service, ...rest } = args;
        console.log(`\n${k(`   → ${u.name.replace("parley_", "").toUpperCase()}`, c.cyan)} ${k(`${service} ${JSON.stringify(rest)}`, c.dim)}`);
        const r = await host.call(u.name, args);
        calls++;
        toolTokens += est(r.text);
        console.log(indent(r.text));
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 401 || /api key|authentication/i.test(err.message)) {
      console.error(k("\n✗ no Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) and try again.", c.red));
    } else throw e;
  } finally {
    rl.close();
    host.close();
  }
  console.log(k(`\n${calls} Parley calls · ${toolTokens} tokens of Parley replies (Lens) · model usage ${inTok} in / ${outTok} out`, c.dim));
}

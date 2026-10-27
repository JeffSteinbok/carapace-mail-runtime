import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionRegistry, executeRules, type MailEnvelope, type MailProviderClient } from "../src/runtime.js";
import {
  buildGateRequest,
  commandEvaluator,
  judge,
  type DecisionEvaluator,
  type DecisionGateConfig,
} from "../src/decisions.js";

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    message_id: "msg-1",
    provider: "test",
    account_id: "acct-1",
    mailbox_id: "inbox",
    sender_name: "Alice Smith",
    sender_email: "alice@example.com",
    subject: "Lunch?",
    body_html: "<p>Are you free <b>Friday</b>?</p>",
    auth_results: { spf: "pass", dkim: "pass", dmarc: "pass" },
    ...overrides,
  };
}

const notifyGate: DecisionGateConfig = {
  questions: {
    notify: { type: "boolean", instructions: "Worth a text?", criteria: { true: "yes", false: "no" }, threshold: 0.5 },
  },
  context: "Family mail: tell me unless it's clearly nothing.",
};

const safeNotifyGate: DecisionGateConfig = {
  questions: {
    safe: { type: "boolean", instructions: "Safe?", criteria: { true: "ok", false: "phishing" }, threshold: 0.8 },
    notify: { type: "boolean", instructions: "Worth a text?", criteria: { true: "yes", false: "no" } },
  },
  on_unavailable: "block",
};

const answer = (p: Record<string, number>) => ({
  status: "ok" as const,
  answers: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: "boolean", probabilityTrue: v }])),
});

describe("buildGateRequest", () => {
  it("sends the email, authentication, owner rule and local time; questions without thresholds", () => {
    const req = buildGateRequest("family", notifyGate, envelope(), { agent: "main", timeout_ms: 9000 }, new Date("2026-10-26T07:30:00Z"));
    expect(req.agentId).toBe("main");
    expect(req.purpose).toBe("mail-gate.family");
    expect(req.timeoutMs).toBe(9000);
    const email = req.request.state.email as Record<string, unknown>;
    expect(email.from).toBe("Alice Smith <alice@example.com>");
    expect(email.bodyExcerpt).toBe("Are you free Friday ?");
    expect(email.authentication).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
    expect(req.request.state.ownerRule).toContain("Family mail");
    expect(req.request.state.quietHours).toBe(true); // 00:30 Pacific
    expect(req.request.questions.notify).not.toHaveProperty("threshold");
  });

  it("gate agent and body_chars override the defaults", () => {
    const req = buildGateRequest("x", { ...notifyGate, agent: "root", body_chars: 0 }, envelope(), { agent: "main" });
    expect(req.agentId).toBe("root");
    expect(req.request.state.email).not.toHaveProperty("bodyExcerpt");
  });
});

describe("judge", () => {
  it("passes only when every question is at or above its threshold", () => {
    expect(judge(safeNotifyGate, answer({ safe: 0.9, notify: 0.6 })).decision).toBe("pass");
    const v = judge(safeNotifyGate, answer({ safe: 0.7, notify: 0.9 }));
    expect(v).toMatchObject({ decision: "block", pass: false, why: "below threshold: safe" });
  });

  it("log mode never stops the actions", () => {
    expect(judge({ ...safeNotifyGate, mode: "log" }, answer({ safe: 0.1, notify: 0.1 }))).toMatchObject({ decision: "block", pass: true });
  });

  it("unavailable follows on_unavailable (default pass)", () => {
    expect(judge(notifyGate, { status: "unavailable", reason: "timeout" })).toMatchObject({ decision: "unavailable", pass: true });
    expect(judge(safeNotifyGate, { status: "unavailable", reason: "timeout" }).pass).toBe(false);
    expect(judge(safeNotifyGate, answer({ safe: 0.9 }))).toMatchObject({ decision: "unavailable", pass: false, why: "no score for notify" });
  });
});

describe("commandEvaluator", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gate-cmd-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fills {params} and reads a wrapped result", async () => {
    const script = join(dir, "fake.sh");
    writeFileSync(script, `#!/bin/sh\necho "$1" > "${dir}/args.json"\necho '{"result":{"status":"ok","answers":{"notify":{"type":"boolean","probabilityTrue":0.7}}}}'\n`);
    chmodSync(script, 0o755);
    const evaluate = commandEvaluator({ command: [script, "{params}"] });
    const out = await evaluate(buildGateRequest("g", notifyGate, envelope()));
    expect(out).toEqual({ status: "ok", answers: { notify: { type: "boolean", probabilityTrue: 0.7 } } });
    expect(JSON.parse(readFileSync(join(dir, "args.json"), "utf8")).purpose).toBe("mail-gate.g");
  });

  it("reports unavailable for a failing or silent transport", async () => {
    expect((await commandEvaluator({ command: ["false"] })(buildGateRequest("g", notifyGate, envelope()))).status).toBe("unavailable");
    expect((await commandEvaluator({ command: ["echo", "nope"] })(buildGateRequest("g", notifyGate, envelope()))).status).toBe("unavailable");
  });
});

describe("executeRules with gates", () => {
  let workspace: string;
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "gate-ws-")); mkdirSync(workspace, { recursive: true }); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const provider = { fetchBody: vi.fn((e: MailEnvelope) => ({ ...e, body_text: "fetched" })), listAttachments: vi.fn(), downloadAttachments: vi.fn() } as unknown as MailProviderClient;

  function setup(evaluator: DecisionEvaluator, extraConfig: Record<string, unknown> = {}) {
    const handler = vi.fn().mockReturnValue([{ kind: "message", payload: { message: "hi" } }]);
    const registry = new ActionRegistry();
    registry.register("notify", handler);
    const rules = [{ id: "family", match: { sender_domain: "example.com" }, gate: "family-notify", actions: ["notify"] }];
    const config = {
      decisions: { log_file: join(workspace, "gate.jsonl") },
      decision_gates: { "family-notify": notifyGate },
      ...extraConfig,
    };
    return { handler, registry, rules, config, evaluator };
  }

  it("runs the actions when the gate passes and logs the decision", async () => {
    const { handler, registry, rules, config } = setup(async () => answer({ notify: 0.8 }));
    const [, results] = await executeRules(envelope(), rules, registry, provider, {
      workspace, logger: vi.fn(), config, decisionEvaluator: async () => answer({ notify: 0.8 }),
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    const line = JSON.parse(readFileSync(join(workspace, "gate.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ gate: "family-notify", rule: "family", decision: "pass", p: { notify: 0.8 }, from: "alice@example.com" });
  });

  it("skips the actions when the gate blocks", async () => {
    const { handler, registry, rules, config } = setup(async () => answer({ notify: 0.2 }));
    const [matched, results] = await executeRules(envelope(), rules, registry, provider, {
      workspace, logger: vi.fn(), config, decisionEvaluator: async () => answer({ notify: 0.2 }),
    });
    expect(matched).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("skips the actions when the rule names a gate that isn't configured", async () => {
    const { handler, registry, rules } = setup(async () => answer({ notify: 1 }));
    const logger = vi.fn();
    await executeRules(envelope(), rules, registry, provider, { workspace, logger, config: {}, decisionEvaluator: async () => answer({ notify: 1 }) });
    expect(handler).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("isn't configured"));
  });

  it("fetches the body for the gate when the envelope has none", async () => {
    const { registry, rules, config } = setup(async () => answer({ notify: 1 }));
    const seen: unknown[] = [];
    await executeRules(envelope({ body_html: null, body_text: null }), rules, registry, provider, {
      workspace, logger: vi.fn(), config,
      decisionEvaluator: async (req) => { seen.push((req.request.state.email as Record<string, unknown>).bodyExcerpt); return answer({ notify: 1 }); },
    });
    expect(seen).toEqual(["fetched"]);
  });

  it("rules without a gate are unaffected", async () => {
    const handler = vi.fn().mockReturnValue([]);
    const registry = new ActionRegistry();
    registry.register("notify", handler);
    const evaluator = vi.fn();
    await executeRules(envelope(), [{ id: "plain", actions: ["notify"] }], registry, provider, {
      workspace, logger: vi.fn(), config: {}, decisionEvaluator: evaluator,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(evaluator).not.toHaveBeenCalled();
  });
});

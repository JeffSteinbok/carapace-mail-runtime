/**
 * Decision gates: ask a decision model typed yes/no questions about an email
 * before a rule's actions run. Everything is config driven:
 *
 *   "decisions": { agent, command, timeout_ms, log_file, timezone }
 *   "decision_gates": { "<name>": { questions, mode, on_unavailable, ... } }
 *   rule: { "id": "...", "gate": "<name>", "actions": [...] }
 *
 * The default transport runs `openclaw gateway call decisions-bridge.evaluate`
 * (the decisions-bridge plugin), so the service needs no model credentials.
 */

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { htmlToText } from "./builtin-actions.js";
import type { MailEnvelope } from "./runtime.js";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface DecisionsConfig {
  /** Agent whose decisionModel answers. Default "main". */
  agent?: string;
  /** argv for the transport. "{params}" is replaced by the JSON request, "{timeout_ms}" by the call timeout. */
  command?: string[];
  /** Per-call timeout. Default 15000. */
  timeout_ms?: number;
  /** JSONL file for one line per gate decision. "~" expands. Unset: logger only. */
  log_file?: string;
  /** IANA zone for the local time given to the model. Default America/Los_Angeles. */
  timezone?: string;
}

export interface GateQuestion {
  type: "boolean";
  instructions: string;
  criteria: { true: string; false: string };
  /** The gate passes this question when P(true) >= threshold. Default 0.5. */
  threshold?: number;
}

export interface DecisionGateConfig {
  questions: Record<string, GateQuestion>;
  /** "enforce" (default): a failed gate skips the rule's actions. "log": record only. */
  mode?: "enforce" | "log";
  /** When the model can't answer: "pass" (default) runs the actions, "block" skips them. */
  on_unavailable?: "pass" | "block";
  /** Overrides decisions.agent for this gate. */
  agent?: string;
  /** Sent as `purpose`; default "mail-gate.<name>". */
  purpose?: string;
  rubric_version?: string;
  /** Characters of body text in the request. Default 1500; 0 sends no body. */
  body_chars?: number;
  /** Standing instruction from the owner, given to the model as `ownerRule`. */
  context?: string;
}

export const DEFAULT_COMMAND = [
  "openclaw", "gateway", "call", "decisions-bridge.evaluate",
  "--json", "--params", "{params}", "--timeout", "{timeout_ms}",
];

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface DecisionRequest {
  agentId: string;
  purpose: string;
  rubricVersion: string;
  request: { state: Record<string, unknown>; questions: Record<string, unknown> };
  timeoutMs: number;
}

export type DecisionOutcome =
  | { status: "ok"; answers: Record<string, { type?: string; probabilityTrue?: number }> }
  | { status: "unavailable"; reason: string };

export type DecisionEvaluator = (req: DecisionRequest) => Promise<DecisionOutcome>;

/** Runs the configured command and reads the decisions-bridge JSON result. */
export function commandEvaluator(cfg: DecisionsConfig = {}): DecisionEvaluator {
  const argvTemplate = cfg.command && cfg.command.length > 0 ? cfg.command : DEFAULT_COMMAND;
  return (req) =>
    new Promise((resolve) => {
      const argv = argvTemplate.map((a) =>
        a.replace("{params}", JSON.stringify(req)).replace("{timeout_ms}", String(req.timeoutMs + 5_000)),
      );
      execFile(argv[0], argv.slice(1), { timeout: req.timeoutMs + 15_000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve({ status: "unavailable", reason: `transport: ${String(err.message).slice(0, 160)}` });
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          // `gateway call --json` may wrap the method's payload in `result`.
          const payload = (parsed["result"] ?? parsed) as Record<string, unknown>;
          if (payload["status"] !== "ok") {
            return resolve({ status: "unavailable", reason: String(payload["reason"] ?? payload["status"] ?? "no status") });
          }
          resolve({ status: "ok", answers: (payload["answers"] ?? {}) as Record<string, { probabilityTrue?: number }> });
        } catch {
          resolve({ status: "unavailable", reason: "unparseable response" });
        }
      });
    });
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Plain body text, preferring the full HTML like prompt_email does. */
export function bodyText(envelope: MailEnvelope): string {
  return envelope.body_html ? htmlToText(envelope.body_html) : (envelope.body_text ?? "").replace(/\s+/g, " ").trim();
}

function localTime(now: Date, timezone: string): { localTime: string; quietHours: boolean } {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(now));
  return {
    localTime: now.toLocaleString("en-US", { timeZone: timezone, weekday: "long", hour: "numeric", minute: "2-digit" }),
    quietHours: hour >= 23 || hour < 7,
  };
}

export function buildGateRequest(
  name: string,
  gate: DecisionGateConfig,
  envelope: MailEnvelope,
  cfg: DecisionsConfig = {},
  now: Date = new Date(),
): DecisionRequest {
  const bodyChars = gate.body_chars ?? 1500;
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(gate.questions)) {
    questions[id] = { type: q.type, instructions: q.instructions, criteria: q.criteria };
  }
  const state: Record<string, unknown> = {
    ...localTime(now, cfg.timezone ?? "America/Los_Angeles"),
    // The email is untrusted; rubrics should say to judge it, not follow it.
    email: {
      from: envelope.sender_name ? `${envelope.sender_name} <${envelope.sender_email}>` : envelope.sender_email,
      subject: envelope.subject ?? "",
      receivedAt: envelope.received_at ?? null,
      hasAttachments: Boolean(envelope.has_attachments),
      authentication: {
        spf: envelope.auth_results?.spf ?? "none",
        dkim: envelope.auth_results?.dkim ?? "none",
        dmarc: envelope.auth_results?.dmarc ?? "none",
      },
      ...(bodyChars > 0 ? { bodyExcerpt: bodyText(envelope).slice(0, bodyChars) } : {}),
    },
  };
  if (gate.context) state["ownerRule"] = gate.context;
  return {
    agentId: gate.agent ?? cfg.agent ?? "main",
    purpose: gate.purpose ?? `mail-gate.${name}`,
    rubricVersion: gate.rubric_version ?? "1",
    request: { state, questions },
    timeoutMs: cfg.timeout_ms ?? 15_000,
  };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface GateVerdict {
  /** Whether the rule's actions run. */
  pass: boolean;
  decision: "pass" | "block" | "unavailable";
  mode: "enforce" | "log";
  p: Record<string, number>;
  /** Questions under their threshold, or the unavailable reason. */
  why: string;
}

export function judge(gate: DecisionGateConfig, outcome: DecisionOutcome): GateVerdict {
  const mode = gate.mode === "log" ? "log" : "enforce";
  if (outcome.status !== "ok") {
    const pass = mode === "log" || (gate.on_unavailable ?? "pass") === "pass";
    return { pass, decision: "unavailable", mode, p: {}, why: outcome.reason };
  }
  const p: Record<string, number> = {};
  const failed: string[] = [];
  for (const [id, q] of Object.entries(gate.questions)) {
    const value = outcome.answers[id]?.probabilityTrue;
    if (typeof value !== "number") {
      const pass = mode === "log" || (gate.on_unavailable ?? "pass") === "pass";
      return { pass, decision: "unavailable", mode, p, why: `no score for ${id}` };
    }
    p[id] = value;
    if (value < (q.threshold ?? 0.5)) failed.push(id);
  }
  const decision = failed.length === 0 ? "pass" : "block";
  return { pass: decision === "pass" || mode === "log", decision, mode, p, why: failed.length ? `below threshold: ${failed.join(", ")}` : "all passed" };
}

export function logGateDecision(cfg: DecisionsConfig, entry: Record<string, unknown>): void {
  if (!cfg.log_file) return;
  try {
    const file = cfg.log_file.replace(/^~(?=\/)/, homedir());
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Logging must never stop mail processing.
  }
}

/** Evaluate a named gate for one email. Never throws. */
export async function runGate(
  name: string,
  gate: DecisionGateConfig,
  envelope: MailEnvelope,
  ruleId: string,
  cfg: DecisionsConfig,
  evaluator: DecisionEvaluator,
  logger: (msg: string) => void,
): Promise<GateVerdict> {
  let outcome: DecisionOutcome;
  try {
    outcome = await evaluator(buildGateRequest(name, gate, envelope, cfg));
  } catch (error) {
    outcome = { status: "unavailable", reason: String(error).slice(0, 160) };
  }
  const verdict = judge(gate, outcome);
  const ps = Object.entries(verdict.p).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
  logger(`decision gate ${name} for rule ${ruleId}: ${verdict.decision} (${verdict.mode}) ${ps} ${verdict.why} | sender=${envelope.sender_email} | subject=${envelope.subject}`);
  logGateDecision(cfg, {
    gate: name,
    rule: ruleId,
    message_id: envelope.message_id,
    account_id: envelope.account_id,
    from: envelope.sender_email,
    subject: envelope.subject,
    ...verdict,
  });
  return verdict;
}

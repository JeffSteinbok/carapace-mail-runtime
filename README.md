# 🦞🐚📬 carapace-mail-runtime

[![CI](https://github.com/JeffSteinbok/carapace-mail-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffSteinbok/carapace-mail-runtime/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/carapace-mail-runtime?logo=npm)](https://www.npmjs.com/package/carapace-mail-runtime)

Provider-agnostic mail processing runtime for [OpenClaw](https://github.com/JeffSteinbok/openclaw). Separates **where mail comes from** from **what you do with it** — any mail source (FastMail, Outlook, webhooks) shares the same rule engine and action handlers.

## Install

```bash
npm install carapace-mail-runtime
```

## Features

| Feature | Description |
|---------|-------------|
| 📨 **MailEnvelope** | Normalized message shape consumed by rules and actions |
| 📋 **Rule engine** | Declarative JSON rules with match conditions (sender, subject, domain, regex, body, attachments, DKIM/SPF/DMARC) |
| ⚡ **Action registry** | Named action handlers with automatic body fetching and attachment downloading |
| 🔌 **Provider protocol** | `MailProviderClient` interface that sources implement to plug into the pipeline |
| 📤 **Result dispatch** | Shared routing of `ActionResult` values into adapter-owned side effects |
| 🧩 **ActionPlugin** | Extension interface for registering custom actions from external packages |
| 🧪 **Decision gates** | Config-defined yes/no questions a decision model answers before a rule's actions run |

## Quick Start

```typescript
import {
  ActionRegistry,
  executeRules,
  registerBuiltinActions,
  dispatchResults,
  type MailEnvelope,
  type MailProviderClient,
} from 'carapace-mail-runtime';

// Set up the action registry with built-in actions
const registry = new ActionRegistry();
registerBuiltinActions(registry, {
  mailboxPrefixResolver: (env) => `[${env.mailbox_id}] `,
});

// Define rules
const rules = [
  {
    id: "shipping-tracking",
    match: { sender_domain: ["fedex.com", "ups.com"] },
    actions: [{ name: "detect_tracking" }],
    continue: true,
  },
  {
    id: "notify-all",
    actions: ["notify_email"],
  },
];

// Process an email
const [matched, results] = await executeRules(
  envelope, rules, registry, providerClient,
  { workspace: "/tmp/mail", logger: console.log },
);

// Dispatch results
dispatchResults(results, {
  logger: console.log,
  handlers: {
    message: (payload) => sendNotification(payload.message),
  },
});
```

## Writing an Action Plugin

Any ESM module exporting a `register` function can be loaded as an action:

```typescript
import type { ActionPlugin, ActionRegistry } from 'carapace-mail-runtime';

export const register: ActionPlugin['register'] = (registry) => {
  registry.register('my_action', async (ctx, params) => {
    const body = await ctx.provider_client.fetchBody(ctx.envelope);
    return [{ kind: 'message', payload: { text: `Got: ${ctx.envelope.subject}` } }];
  }, { needs_body: true });
};
```

## Built-in Actions

| Action | Description |
|--------|-------------|
| `notify_email` | Formats envelope into a notification message with calendar response detection |
| `prompt_email` | Hands the email to an agent with a prompt (`agent`, `prompt`, `include_body`, `session`, and `reply_channel`/`reply_to` for where the reply goes when the agent has no session on that channel). The email is wrapped between a random per-message boundary behind an injection guard; returns an `agent_handoff` result |

> **Note:** `detect_tracking` is available as an external ActionPlugin from [carapace-package-tracking](https://github.com/JeffSteinbok/carapace-package-tracking).

## Rule Match Conditions

| Condition | Description |
|-----------|-------------|
| `sender_email` | Exact email match |
| `sender_domain` | Domain match (includes subdomains) |
| `sender_name_contains` | Substring match on display name |
| `subject` | Exact subject match |
| `subject_contains` | Substring match on subject |
| `subject_prefix` | Subject starts with |
| `subject_regex` | Regex match on subject |
| `body_contains` | Substring match on body |
| `has_attachments` | Boolean presence check |
| `dkim_pass` | Require DKIM pass |
| `spf_pass` | Require SPF pass |
| `dmarc_pass` | Require DMARC pass |

## Decision Gates

A rule can name a **decision gate**: before the rule's actions run, a decision model answers one or more yes/no questions about the email, and the actions run only if every answer clears its threshold. Gates are defined in the same runtime config that holds `mail_rules`, so changing a question, threshold or mode is a config edit (services that watch their config pick it up on reload).

```json
{
  "decisions": {
    "agent": "main",
    "timeout_ms": 15000,
    "log_file": "~/.openclaw/logs/mail-gates.jsonl",
    "timezone": "America/Los_Angeles"
  },
  "decision_gates": {
    "family-notify": {
      "context": "Family mail. Tell me unless it's clearly nothing (an auto-reply, a 'thanks!').",
      "questions": {
        "notify": {
          "type": "boolean",
          "instructions": "Should the owner be texted about this email now?",
          "criteria": { "true": "It needs him or he'd want to know now.", "false": "It can wait until he reads his mail." },
          "threshold": 0.5
        }
      }
    }
  },
  "mail_rules": [
    { "id": "family", "match": { "sender_email": ["mom@example.com"] }, "gate": "family-notify",
      "actions": [{ "name": "prompt_email", "params": { "agent": "main", "prompt": "Summarize this for the owner." } }] }
  ]
}
```

### `decisions` (shared settings)

| Field | Default | Description |
|---|---|---|
| `agent` | `"main"` | Agent whose `decisionModel` answers. With the default transport it must be in the decisions-bridge plugin's `agents` allowlist |
| `command` | see below | argv for the transport. `{params}` is replaced by the JSON request and `{timeout_ms}` by the call timeout plus 5 s |
| `timeout_ms` | `15000` | Per-call timeout |
| `log_file` | unset | JSONL file with one line per gate decision. `~` expands. Unset: the service log only |
| `timezone` | `America/Los_Angeles` | Zone for the local time and quiet hours (23:00–07:00) sent to the model |

The default `command` is

```json
["openclaw", "gateway", "call", "decisions-bridge.evaluate", "--json", "--params", "{params}", "--timeout", "{timeout_ms}"]
```

It asks the running OpenClaw Gateway through the [decisions-bridge](https://github.com/JeffSteinbok/openclaw-hub/tree/main/plugins/decisions-bridge) plugin, so the mail service holds no model credentials. Use an absolute path to `openclaw` if the service's `PATH` doesn't include it. Any command that prints `{"status":"ok","answers":{...}}` (optionally wrapped in `result`) works; anything else counts as unavailable. Hosts can also pass `decisionEvaluator` to `executeRules` to call a model some other way.

### `decision_gates.<name>`

| Field | Default | Description |
|---|---|---|
| `questions` | required | Map of question id to `{ "type": "boolean", "instructions", "criteria": { "true", "false" }, "threshold" }`. `threshold` (default `0.5`) applies to P(true) |
| `mode` | `"enforce"` | `"enforce"`: a failed gate skips the rule's actions. `"log"`: record the decision and run the actions anyway |
| `on_unavailable` | `"pass"` | When the model can't answer (timeout, Gateway down, missing score): `"pass"` runs the actions, `"block"` skips them |
| `context` | unset | The owner's standing instruction for this kind of mail, sent as `ownerRule` |
| `agent` | `decisions.agent` | Per-gate agent override |
| `purpose` | `"mail-gate.<name>"` | Sent to the decision model, for its logs |
| `rubric_version` | `"1"` | Bump when the questions change |
| `body_chars` | `1500` | Characters of body text sent; `0` sends none. The body is fetched first if the envelope doesn't have it |

### What the model sees

`state` holds the local time, `quietHours`, `ownerRule` (from `context`) and `email`: `from`, `subject`, `receivedAt`, `hasAttachments`, `authentication` (`spf`, `dkim`, `dmarc`) and `bodyExcerpt`. The email is untrusted, so write the instructions to judge it rather than follow it. A crafted email can push a score up or down, but the model only returns probabilities and the gate only decides whether the configured actions run.

### Behavior

- Gates run per matched rule, after matching and before that rule's actions. `continue` works as before: a blocked rule doesn't stop later matching rules if it has `continue: true`.
- A rule naming a gate that isn't configured, or one with no questions, skips its actions and logs why (fail closed on config mistakes).
- Each decision is logged to the service log, and to `log_file` when set: `{ ts, gate, rule, message_id, account_id, from, subject, pass, decision, mode, p, why }`, where `decision` is `pass`, `block` or `unavailable`.

## License

MIT

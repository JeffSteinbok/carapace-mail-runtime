# 📬 carapace-mail-runtime

> **🚧 Work in Progress** — This project is under active development and not ready for consumption yet. If you're interested, subscribe to this repo to get notified when it's ready.

[![CI](https://github.com/JeffSteinbok/carapace-mail-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffSteinbok/carapace-mail-runtime/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/carapace-mail-runtime)](https://www.npmjs.com/package/carapace-mail-runtime)

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

## License

MIT

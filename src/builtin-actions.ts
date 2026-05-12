/**
 * Built-in mail action: notify_email.
 *
 * Formats incoming mail into a notification message.
 * detect_tracking is NOT included here — it lives in carapace-package-tracking
 * as a separate ActionPlugin.
 */

import type {
  ActionContext,
  ActionResult,
  ActionRegistry,
  MailEnvelope,
} from "./runtime.js";

// ---------------------------------------------------------------------------
// formatMessage
// ---------------------------------------------------------------------------

export function formatMessage(
  senderStr: string,
  senderEmail: string,
  subject: string,
): string | null {
  const low = (subject ?? "").toLowerCase();

  if (["unsubscribe", "noreply", "no-reply"].some((kw) => low.includes(kw))) {
    return null;
  }

  const responses: Array<[string, string, string]> = [
    ["accepted:", "👍", "accepted"],
    ["declined:", "👎", "declined"],
    ["tentative:", "🤷", "tentative"],
  ];

  for (const [prefix, emoji, verb] of responses) {
    if (low.startsWith(prefix)) {
      const event = subject.slice(prefix.length).trim();
      const name = senderStr.split("<")[0].trim() || senderEmail;
      return `👤 ${name} ${verb} ${emoji}: ${event}`;
    }
  }

  const name = senderStr.split("<")[0].trim() || senderEmail;
  return `📧 ${name}: ${subject}`;
}

// ---------------------------------------------------------------------------
// buildNotifyEmailAction
// ---------------------------------------------------------------------------

export function buildNotifyEmailAction(options: {
  mailboxPrefixResolver: (envelope: MailEnvelope) => string;
}): (ctx: ActionContext, params: Record<string, unknown>) => ActionResult[] {
  const { mailboxPrefixResolver } = options;

  return (ctx: ActionContext, _params: Record<string, unknown>): ActionResult[] => {
    let senderStr = ctx.envelope.sender_email;
    if (ctx.envelope.sender_name) {
      senderStr = `${ctx.envelope.sender_name} <${ctx.envelope.sender_email}>`;
    }
    const message = formatMessage(senderStr, ctx.envelope.sender_email, ctx.envelope.subject);
    if (message === null) {
      ctx.logger(`skipped: ${senderStr} — ${ctx.envelope.subject}`);
      return [];
    }
    const prefix = mailboxPrefixResolver(ctx.envelope);
    return [{ kind: "message", payload: { message: `${prefix}${message}` } }];
  };
}

// ---------------------------------------------------------------------------
// registerBuiltinActions
// ---------------------------------------------------------------------------

/**
 * Register only the built-in notify_email action.
 *
 * For detect_tracking, use the ActionPlugin export from carapace-package-tracking.
 */
export function registerBuiltinActions(
  registry: ActionRegistry,
  options: {
    mailboxPrefixResolver: (envelope: MailEnvelope) => string;
  },
): void {
  const { mailboxPrefixResolver } = options;

  registry.register(
    "notify_email",
    buildNotifyEmailAction({ mailboxPrefixResolver }),
  );
}

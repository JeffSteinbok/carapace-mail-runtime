export {
  type AttachmentMeta,
  type AuthResults,
  type MailEnvelope,
  type ActionResult,
  type MailProviderClient,
  type ActionContext,
  type RegisteredAction,
  type ActionPlugin,
  ActionRegistry,
  normalizeAction,
  ruleMatches,
  selectMatchingRules,
  executeRules,
} from "./runtime.js";

export {
  formatMessage,
  buildNotifyEmailAction,
  buildPromptEmailAction,
  registerBuiltinActions,
} from "./builtin-actions.js";

export { dispatchResults } from "./result-dispatch.js";

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
  describeRuleMatch,
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

export {
  type DecisionsConfig,
  type DecisionGateConfig,
  type GateQuestion,
  type DecisionRequest,
  type DecisionOutcome,
  type DecisionEvaluator,
  type GateVerdict,
  DEFAULT_COMMAND,
  commandEvaluator,
  buildGateRequest,
  judge,
  runGate,
} from "./decisions.js";

export const meta = {
  name: "safe-change",
  description:
    "Evidence-first, least-change delivery for trading-tracker fixes and small features. Pass args:{request:'...'}. Explores, scopes, implements only affected layers, verifies, and applies targeted review fixes.",
  phases: [
    { title: "Explore", detail: "map the live code before proposing a change" },
    { title: "Scope", detail: "make an executable, minimum-change plan" },
    { title: "Research", detail: "verify only external facts the plan depends on" },
    { title: "Implement", detail: "change only the affected backend and/or frontend layer" },
    { title: "Verify", detail: "run the plan's checks and inspect the result" },
    { title: "Review", detail: "adversarial review followed by at most two targeted repairs" },
  ],
};

const request =
  args && (typeof args === "string" ? args : args.request)
    ? typeof args === "string"
      ? args
      : args.request
    : "";

if (!request) {
  log("No request. Invoke with args:{request:'describe the bug fix or small feature'}.");
  return { error: "no request" };
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    changeType: { type: "string", enum: ["bug", "feature", "refactor", "docs"] },
    filesToTouch: { type: "array", items: { type: "string" } },
    backendTasks: { type: "array", items: { type: "string" } },
    frontendTasks: { type: "array", items: { type: "string" } },
    needsUI: { type: "boolean" },
    needsResearch: { type: "boolean" },
    invariants: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    verificationPlan: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "changeType",
    "filesToTouch",
    "backendTasks",
    "frontendTasks",
    "needsUI",
    "needsResearch",
    "invariants",
    "acceptanceCriteria",
    "verificationPlan",
    "openQuestions",
  ],
};

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "changes-needed"] },
    confirmed: { type: "array", items: { type: "string" } },
    unverified: { type: "array", items: { type: "string" } },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          owner: { type: "string", enum: ["backend", "frontend", "both", "none"] },
          area: { type: "string" },
          file: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
        required: ["owner", "area", "problem"],
      },
    },
  },
  required: ["verdict", "confirmed", "unverified", "issues"],
};

async function runEngineer(owner, tasks, context, repairIssues = "") {
  if (!tasks.length) return null;
  const prompt =
    `Implement only the following ${owner} tasks. Read target files first; preserve all stated invariants; ` +
    `do not broaden scope. Report changed files with path:line citations and actual verification output.\n\n` +
    `TASKS:\n${tasks.map((task) => `- ${task}`).join("\n")}\n\n` +
    `CONTEXT:\n${context}` +
    (repairIssues ? `\n\nREPAIR ONLY THESE REVIEW ISSUES:\n${repairIssues}` : "");
  return agent(prompt, {
    agentType: owner === "backend" ? "nifty-backend" : "nifty-frontend",
    model: "sonnet",
    effort: "high",
    label: `${owner}${repairIssues ? "-repair" : ""}`,
  });
}

phase("Explore");
const map = await agent(
  `Map only the code relevant to this request. Cite path:line for every claim, report missing pieces explicitly, and do not propose changes.\n\nREQUEST:\n${request}`,
  { agentType: "nifty-explorer", model: "opus", effort: "high", label: "explore" },
);

phase("Scope");
let plan = await agent(
  `Turn the request and evidence map into the minimum safe implementation plan. ` +
    `Keep backend and frontend tasks empty when that layer is unaffected. Put unresolved product choices in openQuestions; do not guess. ` +
    `Always protect this project's auth/role/CSRF controls, alert state machine, file/Mongo fallback, ` +
    `no-build frontend, and feed configuration boundary when relevant.\n\nREQUEST:\n${request}\n\nEVIDENCE MAP:\n${map}`,
  { agentType: "nifty-architect", model: "opus", effort: "high", label: "scope", schema: PLAN_SCHEMA },
);

if (plan.openQuestions.length) {
  log(`Needs human input: ${plan.openQuestions.join(" | ")}`);
  return { status: "needs-input", plan };
}

let research = null;
if (plan.needsResearch) {
  phase("Research");
  research = await agent(
    `Verify only external facts required for this implementation plan. Cite sources and label anything unverified.\n\nPLAN:\n${plan.summary}\n\nTASKS:\n${[...plan.backendTasks, ...plan.frontendTasks].join("\n")}`,
    { agentType: "nifty-researcher", model: "opus", effort: "high", label: "research" },
  );
}

let design = null;
if (plan.needsUI) {
  phase("Implement");
  design = await agent(
    `Create a concise implementation-ready UI spec using the existing CSS system. Include only the requested surfaces, their loading/error/empty/disabled states, responsive behavior, theme, and keyboard access.\n\nPLAN:\n${plan.summary}\n\nFRONTEND TASKS:\n${plan.frontendTasks.join("\n")}`,
    { agentType: "nifty-ui-designer", model: "opus", effort: "high", label: "ui-spec" },
  );
}

const context =
  `SUMMARY:\n${plan.summary}\n\nINVARIANTS:\n${plan.invariants.map((x) => `- ${x}`).join("\n")}` +
  `\n\nACCEPTANCE CRITERIA:\n${plan.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}` +
  `\n\nVERIFICATION PLAN:\n${plan.verificationPlan.map((x) => `- ${x}`).join("\n")}` +
  (research ? `\n\nRESEARCH:\n${research}` : "") +
  (design ? `\n\nUI SPEC:\n${design}` : "");

phase("Implement");
let backend = await runEngineer("backend", plan.backendTasks, context);
let frontend = await runEngineer("frontend", plan.frontendTasks, context);

let review = null;
for (let round = 0; round < 3; round++) {
  phase(round ? "Verify" : "Review");
  review = await agent(
    `Review the actual implementation against this plan. Re-read every changed file and run the relevant read-only checks. ` +
      `Mark each acceptance criterion confirmed or unverified, and assign every issue to backend, frontend, both, or none.\n\n` +
      `PLAN:\n${JSON.stringify(plan)}\n\nENGINEERING CONTEXT:\n${context}\n\n` +
      `BACKEND REPORT:\n${backend || "not applicable"}\n\nFRONTEND REPORT:\n${frontend || "not applicable"}`,
    { agentType: "nifty-reviewer", model: "opus", effort: "high", label: `review-${round + 1}`, schema: REVIEW_SCHEMA },
  );
  if (review.verdict === "pass" || review.issues.length === 0) break;
  if (round === 2) break;

  const backendIssues = review.issues.filter((issue) => issue.owner === "backend" || issue.owner === "both");
  const frontendIssues = review.issues.filter((issue) => issue.owner === "frontend" || issue.owner === "both");
  if (!backendIssues.length && !frontendIssues.length) break;
  if (backendIssues.length) {
    backend = await runEngineer(
      "backend",
      plan.backendTasks,
      context,
      backendIssues.map((x) => `- [${x.area}] ${x.problem} => ${x.fix || "fix it"}`).join("\n"),
    );
  }
  if (frontendIssues.length) {
    frontend = await runEngineer(
      "frontend",
      plan.frontendTasks,
      context,
      frontendIssues.map((x) => `- [${x.area}] ${x.problem} => ${x.fix || "fix it"}`).join("\n"),
    );
  }
}

return {
  status: review && review.verdict === "pass" ? "done" : "done-with-open-issues",
  plan,
  research: research ? "produced" : null,
  design: design ? "produced" : null,
  backend,
  frontend,
  review,
};

export const meta = {
  name: "feature",
  description:
    "End-to-end feature delivery for trading-tracker: explore -> plan -> design? -> backend -> frontend -> review, grounded in the real code and verified. Pass args:{request:'...'}.",
  phases: [
    { title: "Explore", detail: "map the real code (nifty-explorer)" },
    { title: "Plan", detail: "spec + task split; openQuestions gate (nifty-architect)" },
    { title: "Design", detail: "UI spec, only if needsUI (nifty-ui-designer)" },
    { title: "Backend", detail: "implement backend/*.js (nifty-backend)" },
    { title: "Frontend", detail: "implement frontend (nifty-frontend)" },
    { title: "Review", detail: "adversarial verify + bounded fix loop (nifty-reviewer)" },
  ],
};

const REQUEST =
  args && (typeof args === "string" ? args : args.request) ? (typeof args === "string" ? args : args.request) : null;
if (!REQUEST) {
  log("No request. Invoke with args:{request:'what to build'}.");
  return { error: "no request" };
}

const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    filesToTouch: { type: "array", items: { type: "string" } },
    backendTasks: { type: "array", items: { type: "string" } },
    frontendTasks: { type: "array", items: { type: "string" } },
    needsUI: { type: "boolean" },
    needsResearch: { type: "boolean" },
    risks: { type: "array", items: { type: "string" } },
    verificationPlan: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "backendTasks", "frontendTasks", "needsUI", "openQuestions"],
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
          area: { type: "string" },
          file: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
        required: ["area", "problem"],
      },
    },
  },
  required: ["verdict", "issues"],
};

// 1) EXPLORE - grounded map of the real code
phase("Explore");
const map = await agent(
  `Map the code relevant to this request. Cite path:line for everything you claim; report the actual file layout present now. Request:\n\n${REQUEST}`,
  { agentType: "nifty-explorer", model: "opus", effort: "high", label: "explore" },
);

// 2) (optional) RESEARCH - external facts, decided by the architect below via needsResearch.
// The architect can request it; we run it lazily only when flagged.

// 3) PLAN - spec + task split; hard gate on open questions
phase("Plan");
let spec = await agent(
  `Using this code map, produce the implementable spec + task split for the request. Anything ambiguous or unverifiable goes in openQuestions - do NOT guess.\n\nREQUEST:\n${REQUEST}\n\nCODE MAP:\n${map}`,
  { agentType: "nifty-architect", model: "opus", effort: "high", label: "plan", schema: SPEC_SCHEMA },
);
if (spec.openQuestions && spec.openQuestions.length) {
  log("Open questions - stopping for human input: " + spec.openQuestions.join(" | "));
  return { status: "needs-input", openQuestions: spec.openQuestions, spec };
}

if (spec.needsResearch) {
  phase("Plan");
  const facts = await agent(
    `Verify the external/behavioural facts these tasks depend on; cite sources, flag unverified.\n\nTASKS:\n${spec.summary}`,
    { agentType: "nifty-researcher", model: "opus", effort: "high", label: "research" },
  );
  log("Research done; folding into implementation context.");
  spec = { ...spec, research: facts };
}

// 4) DESIGN - only if UI work is needed
let design = null;
if (spec.needsUI) {
  phase("Design");
  design = await agent(
    `Produce a design spec grounded in the existing CSS design system for these frontend tasks. Cover structure/classes, all states, responsive, light+dark, a11y.\n\nFRONTEND TASKS:\n${(spec.frontendTasks || []).join("\n")}\n\nCONTEXT:\n${spec.summary}`,
    { agentType: "nifty-ui-designer", model: "opus", effort: "high", label: "design" },
  );
}

// 5) IMPLEMENT (backend then frontend) + 6) REVIEW, in a bounded fix loop
let backendResult = null,
  frontendResult = null,
  review = null,
  fixes = "";
for (let round = 1; round <= 3; round++) {
  if (spec.backendTasks && spec.backendTasks.length) {
    phase("Backend");
    backendResult = await agent(
      `Implement these backend tasks, then self-verify (node -c + curl with ALERTS_NO_TICK=1) and report the REAL output.\n\nTASKS:\n${spec.backendTasks.join("\n")}\n\nSPEC:\n${spec.summary}${fixes ? "\n\nFIX THESE REVIEW ISSUES:\n" + fixes : ""}`,
      { agentType: "nifty-backend", model: "sonnet", effort: "high", label: "backend#" + round },
    );
  }
  if (spec.frontendTasks && spec.frontendTasks.length) {
    phase("Frontend");
    frontendResult = await agent(
      `Implement these frontend tasks, then self-verify (new Function syntax check + headless screenshot with ALERTS_NO_TICK=1; back up the file to /tmp first). Report the REAL output + screenshot paths.\n\nTASKS:\n${spec.frontendTasks.join("\n")}\n\nDESIGN SPEC:\n${design || "n/a"}\n\nSPEC:\n${spec.summary}${fixes ? "\n\nFIX THESE REVIEW ISSUES:\n" + fixes : ""}`,
      { agentType: "nifty-frontend", model: "sonnet", effort: "high", label: "frontend#" + round },
    );
  }
  phase("Review");
  review = await agent(
    `Adversarially verify the implementation against the spec. Re-read changed files, run read-only checks (node -c / new Function / grep). Mark CONFIRMED vs UNVERIFIED and list concrete issues.\n\nSPEC:\n${spec.summary}\n\nBACKEND TASKS:\n${(spec.backendTasks || []).join("\n")}\nFRONTEND TASKS:\n${(spec.frontendTasks || []).join("\n")}\n\nBACKEND REPORT:\n${backendResult || "n/a"}\n\nFRONTEND REPORT:\n${frontendResult || "n/a"}`,
    { agentType: "nifty-reviewer", model: "opus", effort: "high", label: "review#" + round, schema: REVIEW_SCHEMA },
  );
  if (review.verdict === "pass" || !review.issues.length) break;
  fixes = review.issues
    .map((i) => `- [${i.area}] ${i.file || ""} ${i.problem} => ${i.fix || ""}`)
    .join("\n");
  log(`Review round ${round}: ${review.issues.length} issue(s) - looping back to engineers.`);
}

return {
  status: review && review.verdict === "pass" ? "done" : "done-with-open-issues",
  spec,
  design: design ? "produced" : null,
  backend: backendResult,
  frontend: frontendResult,
  review,
};

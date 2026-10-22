// A small scripted stand-in for arnx cloud's v1 API, served by Bun.serve on a free
// port: device login, the account, a review's create, project rounds (scripted steps), judge and finish, and a setup
// start. Every request is recorded; `fail` puts error answers in front of a route's normal one; `cut` loses a route's
// answers on the way back (the work was done); a streaming call (Accept: text/event-stream) gets its progress lines,
// then a `result` or an `error` event. Requests missing the fields the CLI must send are answered 422 (`need`).

export const TOKEN = "test-token";
export const HARNESS = "h-2026-10-20.1";

export interface Seen { method: string; path: string; body: unknown; headers: Record<string, string> }
export interface Out { status: number; body: unknown; progress?: string[]; stream?: boolean }
type Handler = (body: Record<string, unknown>, params: Record<string, string>, headers: Headers) => Out;

/** One scripted step of a project round, as the brain answers it (turn, tier, harness and billed are added). */
export type StepScript = Record<string, unknown> & { type: "actions" | "final" | "done" };

export interface CloudScript {
  /** Device login polls before the token: codes answered in turn (authorization_pending, slow_down, ...). */
  polls?: string[];
  balance?: number;
  /** What open holds have reserved (`held_micro_usd`; default 0). */
  held?: number;
  /** The device login's start: fields replaced (`verification_uri_complete: undefined` drops it). */
  device?: Record<string, unknown>;
  /** Each project's round, by name ("*" for any other). */
  rounds?: Record<string, StepScript[]>;
  /** What each billable step costs, by role (default: the round's reviewer). */
  billed?: (path: string, step: StepScript | null) => { role: string; calls: number; cost_micro_usd: number }[];
  /** Verdicts by finding id (default confirmed). */
  verdicts?: Record<string, { verdict: "confirmed" | "disputed" | null; reason: string; depends_on?: string;
    fallback?: boolean }>;
  groups?: unknown[];
  /** Error answers sent before the normal one, by "METHOD /path" with ids as written (`*` matches one segment). */
  fail?: Record<string, Out[]>;
  /** How many of a route's streamed answers (by "METHOD /path" as in `fail`) are lost on the way back: the route
   * ran, the stream ends before its result. */
  cut?: Record<string, number>;
  progress?: string[];
}

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Out =>
  ({ status, body: { code, message, ...extra } });

type Check = [path: string, ok: (v: unknown) => boolean, want: string];
const isStr = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const isBool = (v: unknown) => typeof v === "boolean";
const strList = (v: unknown) => Array.isArray(v) && v.every(isStr);
const at = (body: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) =>
  typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined, body);

/** 422 naming each field the CLI must send and did not (as arnx cloud's contract check would). */
function need(body: unknown, checks: Check[]): Out | null {
  const problems = checks.filter(([path, ok]) => !ok(at(body, path))).map(([path, , want]) => `$.${path}: ${want}`);
  return problems.length ? err(422, "invalid_request", "the request does not fit the contract", { problems }) : null;
}

/** `k` when its "METHOD /pattern" (`*` matches one segment) matches the request, else undefined. */
function keyMatching(k: string, method: string, path: string): string | undefined {
  const [m, pattern] = k.split(" ") as [string, string];
  const want = pattern.split("/"), parts = path.split("/");
  return m === method && want.length === parts.length && want.every((w, i) => w === "*" || w === parts[i])
    ? k : undefined;
}

export interface FakeCloud { url: string; seen: Seen[]; stop: () => void; script: CloudScript;
  /** How many project rounds were started (a start sent again with the same Idempotency-Key starts none). */
  roundsStarted: () => number }

export function fakeCloud(script: CloudScript = {}): FakeCloud {
  const seen: Seen[] = [];
  const polls = [...script.polls ?? []];
  let balance = script.balance ?? 5_000_000;
  const rounds = new Map<string, { steps: StepScript[]; turn: number; done: boolean; last: Out | null;
    answered: Map<number, Out> }>();
  const charged: Record<string, { calls: number; cost: number }> = {};
  let finished = false, judged: Out | null = null;
  /** A project round's start answers, by Idempotency-Key: a start sent again gets the first one's answer. */
  const starts = new Map<string, Out>();
  let started = 0;
  const bill = (path: string, step: StepScript | null) => {
    const by = script.billed?.(path, step) ?? [{ role: "reviewer", calls: 1, cost_micro_usd: 20_000 }];
    for (const r of by) {
      const c = charged[r.role] ??= { calls: 0, cost: 0 };
      c.calls += r.calls;
      c.cost += r.cost_micro_usd;
    }
    return { cost_micro_usd: by.reduce((n, r) => n + r.cost_micro_usd, 0), by_role: by };
  };
  const stepOf = (name: string): Out => {
    const r = rounds.get(name)!;
    const scripted = r.steps.shift() ?? { type: "done", stop: "end_turn" };
    r.turn += 1;
    const free = scripted.type === "done";
    const billed = free ? { cost_micro_usd: 0, by_role: [] } : bill(`round ${name}`, scripted);
    const body: Record<string, unknown> = { turn: r.turn, tier: "medium", harness: HARNESS, billed, ...scripted };
    if (scripted.type === "actions") {
      body.actions = (scripted.actions as Record<string, unknown>[]).map((a, i) => ({ id: `t${r.turn}c${i + 1}`, ...a }));
    }
    if (scripted.type === "done") {
      r.done = true;
      body.reason = scripted.stop === "budget" ? "budget" : "complete";
      body.stop ??= "end_turn";
      body.turns = r.turn;
    }
    const out = { status: 200, body, progress: script.progress ?? ["the agent is taking its turn"] };
    r.last = out;
    return out;
  };
  const routes: Record<string, Handler> = {
    "POST /v1/auth/device": () => ({ status: 200, body: { device_code: "dev-code", user_code: "ABCD-1234",
      verification_uri: "https://arnx.dev/device", verification_uri_complete: "https://arnx.dev/device?code=ABCD-1234",
      expires_in: 600, interval: 1, ...script.device } }),
    "POST /v1/auth/token": () => {
      const code = polls.shift();
      return code ? err(400, code, code) : { status: 200, body: { access_token: TOKEN, token_type: "bearer",
        account_id: "acct_test0001", email: "dev@example.com" } };
    },
    "GET /v1/account": () => ({ status: 200, body: { account_id: "acct_test0001", email: "dev@example.com",
      balance_micro_usd: balance, held_micro_usd: script.held ?? 0, topup_url: "https://arnx.dev/credits",
      caps: { review_cap_micro_usd: 10_000_000, max_concurrent_sessions: 4, max_session_seconds: 3600 } } }),
    "POST /v1/reviews": (b) => {
      const bad = need(b, [["resume_of", strOrNull, "a review id or null"]]);
      if (bad) return bad;
      const projects = ((b.change as { projects: { name: string }[] }).projects).map((p) => p.name);
      for (const p of projects) rounds.delete(p);
      return { status: 201, body: { review_id: "rev_test00000001", tier: b.effort, harness: HARNESS,
        hold_micro_usd: Math.min(Number(b.budget_cap_micro_usd), 2_000_000), balance_micro_usd: balance,
        expires_at: "2026-10-20T12:00:00Z", limits: { max_projects: 8, max_questions: 5 } } };
    },
    "POST /v1/reviews/*/projects/*/agent": (b, p, headers) => {
      if (finished) return err(409, "review_finished", "finished");
      const key = headers.get("idempotency-key");
      const bad = need({ ...b, key }, [["key", isStr, "an Idempotency-Key header"], ["hunt", isBool, "a boolean"],
        ["scope.changed_owned", strList, "a list of paths"], ["scope.changed_used", strList, "a list of paths"],
        ["scope.scoped", isBool, "a boolean"], ["changed_definitions", isStr, "a string"]]);
      if (bad) return bad;
      const kept = starts.get(key!);
      if (kept) return kept;
      started += 1;
      const steps = [...script.rounds?.[p.project!] ?? script.rounds?.["*"] ?? []];
      rounds.set(p.project!, { steps, turn: 0, done: false, last: null, answered: new Map() });
      const out = stepOf(p.project!);
      const first = { ...out, progress: ["hunting", ...out.progress ?? []] };
      starts.set(key!, first);
      return first;
    },
    "POST /v1/reviews/*/projects/*/agent/steps": (b, p) => {
      if (finished) return err(409, "review_finished", "finished");
      const r = rounds.get(p.project!);
      if (!r) return err(409, "loop_not_started", "start the round first");
      const again = r.answered.get(Number(b.turn));
      if (again) return again;
      if (r.done) return err(409, "loop_finished", "the loop is done");
      if (b.turn !== r.turn) return err(409, "turn_conflict", `expected ${r.turn}`, { expected_turn: r.turn });
      const out = stepOf(p.project!);
      r.answered.set(Number(b.turn), out);
      return out;
    },
    "POST /v1/reviews/*/judge": (b) => {
      if (finished) return err(409, "review_finished", "finished");
      if (judged) return { ...judged, body: { ...judged.body as object, billed: { cost_micro_usd: 0, by_role: [] } } };
      const bad = need(b, [["diff", isStr, "the whole change's diff"], ...(b.findings as unknown[])
        .map((_f, i): Check => [`findings.${i}.depends_on`, strOrNull, "a question id or null"])]);
      if (bad) return bad;
      const qs = b.questions as { id: string; question: string }[];
      const prior = new Map(((b.judged ?? []) as { finding_id: string; verdict: string | null; reason: string;
        depends_on: string }[]).map((j) => [j.finding_id, j]));
      const findings = b.findings as { id: string }[];
      const toJudge = findings.filter((f) => !prior.has(f.id)).length;
      const by = [{ role: "merge-questions", calls: 1, cost_micro_usd: 10_000 },
        ...toJudge ? [{ role: "challenge", calls: toJudge, cost_micro_usd: 30_000 * toJudge }] : [],
        { role: "explain", calls: 1, cost_micro_usd: 20_000 }];
      for (const r of by) {
        const c = charged[r.role] ??= { calls: 0, cost: 0 };
        c.calls += r.calls;
        c.cost += r.cost_micro_usd;
      }
      const verdicts = findings.map((f) => {
        const before = prior.get(f.id);
        if (before) return { finding: f.id, verdict: before.verdict, reason: before.reason, depends_on: before.depends_on };
        const v = script.verdicts?.[f.id];
        return { finding: f.id, verdict: v ? v.verdict : "confirmed", reason: v?.reason ?? "the failure matches",
          depends_on: v?.depends_on ?? "", ...(v?.fallback !== undefined ? { fallback: v.fallback } : {}) };
      });
      judged = { status: 200, progress: ["merging questions", "second opinions", "grouping findings"],
        body: { tier: "medium", harness: HARNESS, questions: qs.map((q, i) => ({ id: `Q${i + 1}`, question: q.question,
          merged_from: [q.id] })), verdicts, groups: script.groups ?? [],
        billed: { cost_micro_usd: by.reduce((n, r) => n + r.cost_micro_usd, 0), by_role: by } } };
      return judged;
    },
    "POST /v1/setup": (b) => {
      const bad = need(b, [["project", strOrNull, "a project name or null"], ["add", isBool, "a boolean"]]);
      if (bad) return bad;
      return { status: 200, body: { setup_id: "set_test00000001", step: { type: "done", turn: 1, tier: "medium",
        harness: HARNESS, billed: { cost_micro_usd: 0, by_role: [] }, reason: "complete", stop: "end_turn", turns: 0 } } };
    },
    "POST /v1/reviews/*/finish": () => {
      if (finished) return err(409, "review_finished", "finished");
      finished = true;
      const by = Object.entries(charged).map(([role, c]) => ({ role, calls: c.calls, cost_micro_usd: c.cost }));
      const total = by.reduce((n, r) => n + r.cost_micro_usd, 0);
      balance -= total;
      return { status: 200, body: { review_id: "rev_test00000001", tier: "medium", harness: HARNESS,
        billed_micro_usd: total, by_role: by, balance_micro_usd: balance, state_deleted: true } };
    },
  };
  const match = (method: string, path: string): { key: string; params: Record<string, string> } | null => {
    const parts = path.split("/");
    for (const key of Object.keys(routes)) {
      const [m, pattern] = key.split(" ") as [string, string];
      const want = pattern.split("/");
      if (m !== method || want.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (want.every((w, i) => w === "*" ? (params[i === 3 ? "review" : "project"] = decodeURIComponent(parts[i]!),
        true) : w === parts[i])) return { key, params };
    }
    return null;
  };
  const failKey = (method: string, path: string) => Object.keys(script.fail ?? {})
    .find((k) => keyMatching(k, method, path));
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    const text = await req.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    seen.push({ method: req.method, path: url.pathname, body, headers: Object.fromEntries(req.headers.entries()) });
    const stream = (req.headers.get("accept") ?? "").includes("text/event-stream");
    const key = failKey(req.method, url.pathname);
    const queued = key ? script.fail![key]!.shift() : undefined;
    const open = url.pathname.startsWith("/v1/auth/");
    const route = match(req.method, url.pathname);
    const out: Out = queued ?? (!open && req.headers.get("authorization") !== `Bearer ${TOKEN}`
      ? err(401, "unauthorized", "unknown token") : route ? routes[route.key]!(body, route.params, req.headers)
      : err(404, "not_found", "no such path"));
    const cut = Object.keys(script.cut ?? {}).find((k) => keyMatching(k, req.method, url.pathname));
    if (stream && cut && script.cut![cut]! > 0) {
      script.cut![cut]! -= 1;
      return new Response(`: keepalive\n\nevent: progress\ndata: ${JSON.stringify({ message: "working" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }
    if (!stream || (out.status >= 400 && !out.stream)) return Response.json(out.body, { status: out.status });
    const events = [": keepalive", ...(out.progress ?? []).map((m) => `event: progress\ndata: ${JSON.stringify({
      message: m, phase: "turn" })}`), out.status >= 400 ? `event: error\ndata: ${JSON.stringify({ ...out.body as object,
      status: out.status })}` : `event: result\ndata: ${JSON.stringify(out.body)}`];
    return new Response(events.join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  return { url: `http://localhost:${server.port}`, seen, stop: () => server.stop(true), script,
    roundsStarted: () => started };
}

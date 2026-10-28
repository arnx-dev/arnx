// A first review.yaml written from the detection's facts without a model, for the setup agent to edit instead of
// writing one from scratch. Values the files did not settle carry a `# unsure: <why>` comment. It leaves out what
// setup decides from the runs (tests_dir) and from the coverage (owns beyond the root, uses, uncovered).
import { Document, isMap, isScalar, isSeq, type Node } from "yaml";
import type { Candidate, Detection } from "./detect";
import type { ProjectFacts, ServiceFact } from "./facts";

type Raw = Record<string, unknown>;
interface Mark { path: (string | number)[]; why: string }

const DEFAULT_VERSION = { node: "22", python: "3.12", rust: "1", bun: "1" } as const;
const NEXTEST = "curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /usr/local/cargo/bin";
const PYTEST = "pytest hypothesis";
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const READY: Record<string, (env: Record<string, string>) => string> = {
  postgres: (env) => `pg_isready -U ${env.POSTGRES_USER ?? "postgres"}`,
  mysql: () => "mysqladmin ping -h 127.0.0.1 --silent",
  redis: () => "redis-cli ping",
  mongo: () => "mongosh --quiet --eval 'db.runCommand({ping: 1})'",
  rabbitmq: () => "rabbitmq-diagnostics -q ping",
};
const MAX_PROJECTS = 40;

/** The candidates the draft proposes as projects: those with test files of their own, and those without that hold
 * source files of their language no other drafted project owns (setup proves them with arnx's one-line test; the
 * rest the coverage map lists as untested). Deeper candidates are taken first, so a workspace root claims only the
 * files its packages leave. Without any test files or sources: the outermost candidate of each language. */
function chosen(d: Detection): Candidate[] {
  const supported = d.candidates.filter((c) => c.language !== "other");
  const under = (p: string, root: string) => root === "." || p.startsWith(root + "/");
  const out = supported.filter((c) => (c.ownTests ?? 0) > 0);
  const depth = (c: Candidate) => (c.root === "." ? 0 : c.root.split("/").length);
  for (const c of supported.filter((x) => !out.includes(x)).sort((a, b) => depth(b) - depth(a))) {
    if ((d.sources?.[c.language] ?? []).some((p) => under(p, c.root) && !out.some((o) => under(p, o.root)))) out.push(c);
  }
  // Past the cap, packages with tests stay before ones without.
  if (out.length) return out.slice(0, MAX_PROJECTS).sort((a, b) => supported.indexOf(a) - supported.indexOf(b));
  return supported.filter((c) => !supported.some((o) => o.language === c.language && o.root !== c.root &&
    (o.root === "." || c.root.startsWith(o.root + "/")))).slice(0, 10);
}

/** Project names from roots: the last folder, or the last two when that is taken. */
function names(cs: Candidate[]): string[] {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "main";
  const out: string[] = [];
  for (const c of cs) {
    const parts = c.root === "." ? ["main"] : c.root.split("/");
    let name = clean(parts.at(-1)!);
    if (out.includes(name) && parts.length > 1) name = clean(parts.slice(-2).join("-"));
    if (out.includes(name)) name = `${name}-${c.language === "typescript" ? "js" : c.language === "python" ? "py" : "rs"}`;
    let n = 2;
    const base = name;
    while (out.includes(name)) name = `${base}-${n++}`;
    out.push(name);
  }
  return out;
}

/** The draft as an object and the marks of what it is unsure about; null when there is nothing to propose. */
export function draftReview(d: Detection): { doc: Raw; marks: Mark[] } | null {
  const facts = d.facts;
  const cs = chosen(d);
  if (!facts || !cs.length) return null;
  const marks: Mark[] = [];
  const projects: Raw = {};
  const used = new Set<string>();
  const allow = new Set<string>();
  names(cs).forEach((name, i) => {
    const c = cs[i]!;
    const f = facts.projects.find((p) => p.root === c.root && p.language === c.language);
    if (!f) return;
    const mark = (key: string | (string | number)[], why: string) =>
      marks.push({ path: ["projects", name, ...(Array.isArray(key) ? key : [key])], why });
    const p: Raw = { root: c.root, language: c.language };
    if (!(c.ownTests ?? 0)) mark("root", "no test files found here");
    const built = c.language === "typescript" ? jsProject(c, f, d, mark)
      : c.language === "python" ? pythonProject(f, mark) : rustProject(c, f, mark);
    Object.assign(p, built);
    const services = f.services.map((s) => s.value);
    if (services.length) {
      p.services = services;
      services.forEach((s, j) => {
        used.add(s);
        const why = f.services[j]!.from;
        if (!why.includes("starts it")) mark(["services", j], why);
      });
    }
    if (Object.keys(f.env).length) {
      p.env = { ...f.env };
      for (const k of Object.keys(f.env)) if (SECRET.test(k)) allow.add(k);
      mark("env", "taken from CI or compose; check the values");
    }
    projects[name] = p;
  });
  const services: Raw = {};
  for (const s of facts.services.filter((x) => used.has(x.name))) {
    services[s.name] = service(s);
    for (const k of Object.keys((services[s.name] as Raw).env as Raw ?? {})) if (SECRET.test(k)) allow.add(k);
    if (!READY[s.kind ?? ""]) marks.push({ path: ["services", s.name, "image"], why: "no readiness check known" });
  }
  const doc: Raw = { version: 1 };
  if (Object.keys(services).length) doc.services = services;
  if (allow.size) doc.allow_env_names = [...allow].sort();
  doc.projects = projects;
  return { doc, marks };
}

/** The draft as review.yaml text with its `# unsure` comments; "" when there is nothing to propose. */
export function draftYaml(d: Detection): string {
  const draft = draftReview(d);
  if (!draft) return "";
  const doc = new Document(draft.doc);
  for (const m of draft.marks) {
    const node = doc.getIn(m.path, true) as Node | undefined;
    if (!node) continue;
    const note = ` unsure: ${m.why}`;
    if (isScalar(node)) node.comment = node.comment ? `${node.comment};${note.slice(8)}` : note;
    else if (isMap(node) || isSeq(node)) {
      // A list or mapping takes the comment on its key's line.
      const parent = doc.getIn(m.path.slice(0, -1), true);
      const pair = isMap(parent) ? parent.items.find((it) => isScalar(it.key) && it.key.value === m.path.at(-1)) : null;
      if (pair && isScalar(pair.key)) pair.key.commentBefore = note;
    }
  }
  return doc.toString({ lineWidth: 0 });
}

function service(s: ServiceFact): Raw {
  const env = { ...s.env };
  if (s.kind === "postgres" && !env.POSTGRES_PASSWORD && !env.POSTGRES_HOST_AUTH_METHOD) env.POSTGRES_PASSWORD = "test";
  if (s.kind === "mysql" && !env.MYSQL_ROOT_PASSWORD && !env.MYSQL_ALLOW_EMPTY_PASSWORD && !env.MARIADB_ROOT_PASSWORD) {
    env.MYSQL_ROOT_PASSWORD = "test";
  }
  const out: Raw = { image: s.image };
  if (Object.keys(env).length) out.env = env;
  const ready = READY[s.kind ?? ""];
  if (ready) out.ready = ready(env);
  return out;
}

type MarkFn = (key: string | (string | number)[], why: string) => void;

/** The image of a project's language, its version from the facts or a default (marked). */
function image(f: ProjectFacts, tool: "node" | "python" | "rust" | "bun", mark: MarkFn): string {
  const v = f.versions[tool];
  const repo = tool === "bun" ? "oven/bun" : tool;
  if (!v) mark("image", `no ${tool === "bun" ? "Bun" : tool[0]!.toUpperCase() + tool.slice(1)} version found`);
  else if (/range|engines|ships/.test(v.from)) mark("image", `picked from ${v.from}`);
  return `${repo}:${v?.value ?? DEFAULT_VERSION[tool]}`;
}

const aptLine = (pkgs: string[]) =>
  `apt-get update && apt-get install -y --no-install-recommends ${pkgs.join(" ")} && rm -rf /var/lib/apt/lists/*`;

function jsProject(c: Candidate, f: ProjectFacts, d: Detection, mark: MarkFn): Raw {
  const manager = f.manager?.value ?? "npm";
  let runner = c.runner && ["vitest", "jest", "node", "bun"].includes(c.runner) ? c.runner : null;
  // node --test has describe and it too, as imports: mocha suites run under it with those made global.
  if (c.runner === "mocha") mark("runner", "the tests are mocha's; node --test runs them once describe and it are global");
  else if (!runner) mark("runner", "no runner found");
  // A package without tests runs arnx's one-line test, which node --test runs with nothing installed.
  runner ??= c.runner === "mocha" || !(c.ownTests ?? 0) ? "node" : manager === "bun" ? "bun" : "vitest";
  const bun = runner === "bun" || manager === "bun";
  const p: Raw = { runner, image: image(f, bun ? "bun" : "node", mark) };
  const ci = !f.lockfile ? "npm install"
    : manager === "pnpm" ? "pnpm install --frozen-lockfile"
    : manager === "yarn" ? "yarn install --frozen-lockfile"
    : manager === "yarn-berry" ? "yarn install --immutable"
    : manager === "bun" ? "bun install --frozen-lockfile" : "npm ci";
  const corepack = !bun && (manager === "pnpm" || manager === "yarn-berry") ? "corepack enable && " : "";
  if (!f.lockfile) mark("install", "no lockfile found");
  const workspace = f.installRoot !== c.root || d.workspaces.includes(c.root);
  let link: string;
  if (workspace) {
    // The whole workspace installs outside /src; each node_modules folder is linked back before the tests run.
    const back = f.installRoot === "." ? "/src" : `/src/${f.installRoot}`;
    if (f.installRoot !== c.root) p.install_root = f.installRoot;
    p.install = [`${corepack}mkdir -p /opt/ws && cp -a . /opt/ws/ && cd /opt/ws && ${ci}`,
      `printf '#!/bin/sh\\ncd /opt/ws && find . -name node_modules -type d -prune | while read -r d; do ln -sfn "/opt/ws/$d" "${back}/$d"; done\\n' > /usr/local/bin/link-deps && chmod +x /usr/local/bin/link-deps`];
    link = "link-deps && ";
    mark(["install", 0], "one install for the workspace; check that its packages resolve");
  } else {
    const files = f.needsTree ? "-a ." : ["package.json", ...f.lockfile ? [f.lockfile] : [], ...f.copy].join(" ");
    p.install = [`${corepack}mkdir -p /opt/deps && cp ${f.copy.includes(".yarn") && !f.needsTree ? "-r " : ""}${files} /opt/deps/ && cd /opt/deps && ${ci}`];
    link = "ln -sfn /opt/deps/node_modules node_modules && ";
  }
  const loader = f.deps.includes("tsx") ? " --import tsx" : f.deps.includes("ts-node")
    ? " --require ts-node/register/transpile-only" : "";
  const run = { vitest: "npx vitest run", jest: "npx jest", node: `node --test${loader}`, bun: "bun test" }[runner]!;
  p.test_command = `${link}${run} {targets}`;
  if (c.evidence.some((e) => e.startsWith("tsconfig.json and typescript"))) {
    p.typecheck = `${link}npx tsc --noEmit -p tsconfig.json`;
  }
  return p;
}

function pythonProject(f: ProjectFacts, mark: MarkFn): Raw {
  const p: Raw = { runner: "pytest", image: image(f, "python", mark) };
  const install: string[] = [];
  if (f.apt.length) install.push(aptLine(f.apt));
  const extras = f.extras.length ? `[${f.extras.join(",")}]` : "";
  const reqs = f.requirements.map((r) => `-r ${r}`).join(" ");
  const manager = f.manager?.value ?? "pip";
  if (manager === "uv") {
    const groups = f.groups.filter((g) => g !== "dev").map((g) => ` --group ${g}`).join("");
    install.push(`pip install uv && UV_PROJECT_ENVIRONMENT=/usr/local uv sync --frozen${f.installRoot !== f.root ? " --all-packages" : ""}${f.extras.map((e) => ` --extra ${e}`).join("")}${groups}`);
  } else if (manager === "poetry") {
    install.push(`pip install poetry && poetry config virtualenvs.create false && poetry install --no-interaction${f.groups.length ? ` --with ${f.groups.join(",")}` : ""}${f.installable ? "" : " --no-root"}`);
  } else if (manager === "pipenv") {
    install.push(`pip install pipenv && pipenv install --system --dev${f.lockfile === "Pipfile.lock" ? " --deploy" : ""}`);
  } else if (manager === "pdm") {
    install.push("pip install pdm && pdm export --dev --without-hashes -o /tmp/requirements.txt && pip install -r /tmp/requirements.txt");
  } else if (reqs || f.installable) {
    install.push(`pip install ${[reqs, f.installable ? `-e '.${extras}'` : ""].filter(Boolean).join(" ")}`);
  } else mark("install", "no requirements found");
  install.push(`pip install ${PYTEST}`);
  if (f.apt.length) mark(["install", 0], `system packages ${f.jobs[0] ?? "CI"} installs`);
  if (f.installRoot !== f.root) p.install_root = f.installRoot;
  p.install = install;
  p.test_command = "python -m pytest {targets}";
  return p;
}

function rustProject(c: Candidate, f: ProjectFacts, mark: MarkFn): Raw {
  const p: Raw = { runner: "nextest", image: image(f, "rust", mark) };
  const apt = [...new Set([...f.apt, ...f.lockApt])];
  if (f.installRoot !== c.root) p.install_root = f.installRoot;
  // The whole workspace's test build goes into the image; tests run filtered to the crate.
  p.install = [...apt.length ? [aptLine(apt)] : [], NEXTEST, "cargo nextest run --workspace --no-run"];
  if (apt.length) mark(["install", 0], f.apt.length ? "system packages CI installs" : "system packages Cargo.lock suggests");
  p.test_command = "cargo nextest run {targets}";
  return p;
}

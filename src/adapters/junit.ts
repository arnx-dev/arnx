// JUnit XML, the common report format (pytest, vitest, node:test, bun, cargo-nextest). `junitCases` walks the report
// and keeps each test case with the chain of suites around it; adapters turn cases into TestResults their own way.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { TestResult } from "./types";

export const MESSAGE_LIMIT = 4000;

type Node = Record<string, unknown> & { ":@"?: Record<string, string> };

/** One test case: its attributes, the attributes of the suites around it (outermost first), and its outcome. */
export interface JunitCase {
  attrs: Record<string, string>;
  suites: Record<string, string>[];
  outcome: string;
  message: string;
}

const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false,
  parseAttributeValue: false, trimValues: false, processEntities: true, htmlEntities: true,
});

const tagOf = (n: Node) => Object.keys(n).find((k) => k !== ":@") ?? "";
const children = (n: Node) => (n[tagOf(n)] as Node[] | undefined) ?? [];
const textOf = (n: Node) => children(n).map((c) => typeof c["#text"] === "string" ? c["#text"] : "").join("");

/** Every test case in a JUnit report, in document order; null when it is not well-formed XML. */
export function junitCases(xml: string): JunitCase[] | null {
  if (XMLValidator.validate(xml) !== true) return null;
  let tree: Node[];
  try {
    tree = parser.parse(xml) as Node[];
  } catch {
    return null;
  }
  const out: JunitCase[] = [];
  const walk = (nodes: Node[], suites: Record<string, string>[]) => {
    for (const n of nodes) {
      const tag = tagOf(n);
      if (tag === "testcase") out.push(testCase(n, suites));
      else if (tag === "testsuite") walk(children(n), [...suites, n[":@"] ?? {}]);
      else if (tag && tag !== "#text") walk(children(n), suites);
    }
  };
  walk(tree, []);
  return out;
}

function testCase(n: Node, suites: Record<string, string>[]): JunitCase {
  let outcome = "passed", message = "";
  for (const [tag, label] of [["failure", "failed"], ["error", "error"], ["skipped", "skipped"]] as const) {
    const el = children(n).find((c) => tagOf(c) === tag);
    if (el) {
      outcome = label;
      message = (((el[":@"] ?? {}).message ?? "") + "\n" + textOf(el)).trim().slice(0, MESSAGE_LIMIT);
      break;
    }
  }
  return { attrs: n[":@"] ?? {}, suites, outcome, message };
}

/** pytest-style results: the id is "<file>::<class>::<name>". `moduleOf` turns a file attribute into the dotted
 * module name the runner uses as a classname prefix (empty when it has none). */
export function parseJunit(xml: string, moduleOf: (fileAttr: string) => string): TestResult[] | null {
  const cases = junitCases(xml);
  if (cases === null) return null;
  return cases.map(({ attrs, outcome, message }) => {
    const fileAttr = attrs.file ?? "";
    const classname = attrs.classname ?? "";
    const name = attrs.name ?? "";
    const module = moduleOf(fileAttr);
    const cls = module && classname.startsWith(module + ".") ? classname.slice(module.length + 1) : "";
    const testId = [fileAttr || classname, cls, name].filter(Boolean).join("::");
    return { testId, fileAttr, name, outcome, message };
  });
}

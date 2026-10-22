/** xml.sax.saxutils.quoteattr */
function quoteattr(data: string): string {
  let d = data.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");
  if (d.includes('"')) {
    if (d.includes("'")) d = `"${d.replaceAll('"', "&quot;")}"`;
    else d = `'${d}'`;
  } else {
    d = `"${d}"`;
  }
  return d;
}

/** cases: [file relative to rootdir, test name, outcome passed|failed|error|skipped, message]. */
export function junitXml(cases: [string, string, string, string][]): string {
  const rows = cases.map(([file, name, outcome, message]) => {
    const classname = file.slice(0, -3).replaceAll("/", ".");
    const inner = { failed: `<failure message=${quoteattr(message)}>trace</failure>`,
      error: `<error message=${quoteattr(message)}>trace</error>`,
      skipped: `<skipped message=${quoteattr(message)}/>`, passed: "" }[outcome];
    return `<testcase classname="${classname}" name="${name}" file="${file}" line="1" time="0.01">${inner}</testcase>`;
  });
  return `<?xml version="1.0"?><testsuites><testsuite name="pytest">${rows.join("")}</testsuite></testsuites>`;
}

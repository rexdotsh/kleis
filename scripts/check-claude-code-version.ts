// Compares the Claude Code and Bun versions Kleis emulates with the latest
// Claude Code release, and opens, updates or closes one tracking issue.
// Run with `bun scripts/check-claude-code-version.ts [--dry-run]`.
// Needs GITHUB_REPOSITORY, and GITHUB_TOKEN unless it is a dry run.
import packageJson from "../package.json";
import { EMULATED_CLAUDE_CODE_VERSION } from "../src/providers/proxies/claude-version-response";
import { isObjectRecord } from "../src/utils/object";

const PACKAGE = "@anthropic-ai/claude-code";
const BINARY_PACKAGE = "@anthropic-ai/claude-code-linux-x64";
const ISSUE_MARKER = "<!-- kleis:claude-code-version-check -->";
// The workflow's GITHUB_TOKEN acts as this bot. Anyone can quote the marker,
// so only issues the bot opened are tracked.
const ISSUE_AUTHOR = "github-actions[bot]";

const dryRun = process.argv.includes("--dry-run");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository) {
  throw new Error("GITHUB_REPOSITORY is required");
}
if (!token && !dryRun) {
  throw new Error("GITHUB_TOKEN is required unless --dry-run is set");
}

const fetchJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url} failed: ${response.status} ${await response.text()}`
    );
  }
  return response.json();
};

const readString = (value: unknown, key: string): string => {
  const field = isObjectRecord(value) ? value[key] : undefined;
  if (typeof field !== "string") {
    throw new Error(`Expected a string ${key}`);
  }
  return field;
};

// The standalone binary embeds Bun, whose version appears in strings such as
// "Bun v1.4.4 (Linux x64)". Scanning the decompressed tar stream finds them
// without writing the ~290MB binary to disk.
const readEmbeddedBunVersion = async (version: string): Promise<string> => {
  const manifest = await fetchJson(
    `https://registry.npmjs.org/${BINARY_PACKAGE}/${version}`
  );
  const tarball = readString(
    isObjectRecord(manifest) ? manifest.dist : null,
    "tarball"
  );
  const response = await fetch(tarball);
  if (!response.ok || !response.body) {
    throw new Error(`GET ${tarball} failed: ${response.status}`);
  }
  const pattern = /Bun v(\d+\.\d+\.\d+)/g;
  const found = new Set<string>();
  const decoder = new TextDecoder("latin1");
  let tail = "";
  const scan = (text: string, final: boolean) => {
    let keepFrom = Math.max(0, text.length - 32);
    for (const match of text.matchAll(pattern)) {
      // A version at the end of a chunk may continue in the next one.
      if (!final && match.index + match[0].length === text.length) {
        keepFrom = Math.min(keepFrom, match.index);
      } else if (match[1]) {
        found.add(match[1]);
      }
    }
    tail = text.slice(keepFrom);
  };
  for await (const chunk of response.body.pipeThrough(
    new DecompressionStream("gzip")
  )) {
    scan(tail + decoder.decode(chunk, { stream: true }), false);
  }
  scan(tail + decoder.decode(), true);
  const versions = [...found];
  if (versions.length !== 1 || !versions[0]) {
    throw new Error(
      `Expected one Bun version in ${BINARY_PACKAGE}@${version}, found: ${versions.join(", ") || "none"}`
    );
  }
  return versions[0];
};

const emulatedClaudeCode = EMULATED_CLAUDE_CODE_VERSION;
const emulatedBun = /^bun@(\S+)$/.exec(packageJson.packageManager)?.[1];
if (!emulatedClaudeCode || !emulatedBun) {
  throw new Error("Could not read the emulated Claude Code or Bun version");
}

const latestClaudeCode = readString(
  await fetchJson(`https://registry.npmjs.org/${PACKAGE}/latest`),
  "version"
);
const latestBun = await readEmbeddedBunVersion(latestClaudeCode);
const claudeCodeBehind =
  Bun.semver.order(emulatedClaudeCode, latestClaudeCode) < 0;
// The TLS and HTTP fingerprint only matches with the exact same Bun.
const bunMismatched = emulatedBun !== latestBun;

console.info(
  JSON.stringify({
    claudeCode: { emulated: emulatedClaudeCode, latest: latestClaudeCode },
    bun: { emulated: emulatedBun, latest: latestBun },
    claudeCodeBehind,
    bunMismatched,
  })
);

const releaseUrl = `https://www.npmjs.com/package/${PACKAGE}/v/${latestClaudeCode}`;
const title = `Claude Code ${latestClaudeCode} is out (Kleis emulates ${emulatedClaudeCode} on Bun ${emulatedBun})`;
const body = `${ISSUE_MARKER}
The latest [\`${PACKAGE}\` ${latestClaudeCode}](${releaseUrl}) differs from what Kleis emulates.

| | Kleis | Latest Claude Code |
|---|---|---|
| Claude Code | ${emulatedClaudeCode} | ${latestClaudeCode} |
| Bun | ${emulatedBun} | ${latestBun} |

${claudeCodeBehind ? `- Bump \`CLAUDE_CLI_USER_AGENT\` in \`src/providers/constants.ts\` to ${latestClaudeCode}.\n` : ""}${bunMismatched ? `- Set Bun to ${latestBun} in \`package.json#packageManager\`, the \`Dockerfile\` and \`@types/bun\`.\n` : ""}
This issue is updated daily by the Claude Code version check workflow and closes itself once both versions are current.
`;

const github = (path: string, init?: RequestInit) =>
  fetchJson(`https://api.github.com/repos/${repository}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

const findOpenIssues = async () => {
  const issues: { number: number; title: string; body: string }[] = [];
  for (let page = 1; ; page++) {
    const batch = await github(
      `/issues?state=open&creator=${encodeURIComponent(ISSUE_AUTHOR)}&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch)) {
      throw new Error("Expected a list of issues");
    }
    for (const issue of batch) {
      if (
        isObjectRecord(issue) &&
        !issue.pull_request &&
        isObjectRecord(issue.user) &&
        issue.user.login === ISSUE_AUTHOR &&
        typeof issue.number === "number" &&
        typeof issue.body === "string" &&
        issue.body.includes(ISSUE_MARKER)
      ) {
        issues.push({
          number: issue.number,
          title: String(issue.title),
          body: issue.body,
        });
      }
    }
    if (batch.length < 100) return issues;
  }
};

const run = async (description: string, action: () => Promise<unknown>) => {
  console.info(`${dryRun ? "[dry run] would " : ""}${description}`);
  if (!dryRun) await action();
};

const [existing, ...duplicates] = await findOpenIssues();
const stale = claudeCodeBehind || bunMismatched;

if (stale) {
  if (!existing) {
    await run(`open an issue: ${title}`, () =>
      github("/issues", {
        method: "POST",
        body: JSON.stringify({ title, body }),
      })
    );
  } else if (existing.title !== title || existing.body !== body) {
    await run(`update issue #${existing.number}: ${title}`, () =>
      github(`/issues/${existing.number}`, {
        method: "PATCH",
        body: JSON.stringify({ title, body }),
      })
    );
  } else {
    console.info(`Issue #${existing.number} is up to date`);
  }
  if (dryRun) console.info(`\n${body}`);
}

for (const issue of stale ? duplicates : [existing, ...duplicates]) {
  if (!issue) continue;
  await run(`close issue #${issue.number}`, async () => {
    await github(`/issues/${issue.number}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: stale
          ? `Duplicate of #${existing?.number}.`
          : `Kleis emulates Claude Code ${emulatedClaudeCode} on Bun ${emulatedBun}, matching the latest release.`,
      }),
    });
    await github(`/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        state: "closed",
        state_reason: stale ? "not_planned" : "completed",
      }),
    });
  });
}

if (!stale && !existing) {
  console.info("Both versions are current; no open issue");
}

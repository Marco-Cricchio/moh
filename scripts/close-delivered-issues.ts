type Release = {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
};

type Compare = { commits: Array<{ sha: string }> };
type PullRequest = { body: string | null; merged_at: string | null };
type Issue = { state: "open" | "closed"; pull_request?: unknown };

/** Extract only GitHub closing-keyword directives, never incidental #N references. */
export function closingIssueNumbers(text: string): number[] {
  const numbers = new Set<number>();
  const directive = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi;
  for (const match of text.matchAll(directive)) numbers.add(Number(match[1]));
  return [...numbers];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${required("GITHUB_API_URL")}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${required("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function main() {
  const repo = required("GITHUB_REPOSITORY");
  const currentReleaseId = Number(required("RELEASE_ID"));
  const currentTag = required("RELEASE_TAG");
  const releaseUrl = required("RELEASE_URL");
  const releases = await github<Release[]>(`/repos/${repo}/releases?per_page=100`);
  const previous = releases.find(
    (release) =>
      release.id !== currentReleaseId && !release.draft && !release.prerelease && release.published_at !== null,
  );

  if (!previous) {
    console.log("No preceding published stable release; no delivered issues to close.");
    return;
  }

  const compare = await github<Compare>(
    `/repos/${repo}/compare/${encodeURIComponent(previous.tag_name)}...${encodeURIComponent(currentTag)}`,
  );
  const issueNumbers = new Set<number>();
  for (const { sha } of compare.commits) {
    const pullRequests = await github<PullRequest[]>(`/repos/${repo}/commits/${sha}/pulls`);
    for (const pullRequest of pullRequests) {
      if (pullRequest.merged_at) {
        for (const number of closingIssueNumbers(pullRequest.body ?? "")) issueNumbers.add(number);
      }
    }
  }

  for (const number of issueNumbers) {
    const issue = await github<Issue>(`/repos/${repo}/issues/${number}`);
    if (issue.state !== "open" || issue.pull_request) continue;
    await github(`/repos/${repo}/issues/${number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });
    await github(`/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: `Delivered in ${releaseUrl}.` }),
    });
    console.log(`Closed #${number}.`);
  }
}

if (import.meta.main) await main();

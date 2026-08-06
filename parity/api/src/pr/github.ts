/**
 * The GitHub API, over plain `fetch`.
 *
 * No Octokit. `parity/api` depends on six packages and this would be the seventh for four
 * REST calls, all of which are documented, stable and boring. It is also the whole of the
 * "PR adapter is one interface" claim in `docs/SPEC.md` §1 — GitHub here, Azure DevOps in
 * production is a swap of this file, and a file a person can read in one sitting makes that
 * a credible sentence rather than a hopeful one.
 *
 * The Git Data API rather than the Contents API: blobs → tree → commit → ref produces ONE
 * commit containing every file, where the Contents API produces one commit per file. A
 * migration that lands as five separate commits reads as five separate changes.
 *
 * Nothing here touches a working tree. Parity has no checkout of the repository it opens PRs
 * against and does not need one — `docs/SPEC.md` §2 names the GitHub API as one of the three
 * channels through which the platform reaches the estate's repository, and this is it.
 */

export interface GithubTarget {
  token: string;
  owner: string;
  repo: string;
}

export interface CommitFile {
  path: string;
  contents: string;
}

export interface OpenedPr {
  number: number;
  url: string;
}

const API = 'https://api.github.com';

class GithubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    // The response body carries GitHub's own explanation — a 422 on a ref that exists reads
    // very differently from a 422 on a bad base — so it is kept rather than flattened to the
    // status code.
    super(`GitHub ${status} on ${path}: ${body.slice(0, 400)}`);
    this.name = 'GithubError';
  }
}

async function call<T>(target: GithubTarget, path: string, init?: { method: string; body: unknown }): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${target.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'parity-platform',
    },
    body: init === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) throw new GithubError(response.status, path, await response.text());
  return (await response.json()) as T;
}

/** Does the configured repository actually resolve? Asked before assembling, not at push time. */
export async function repoExists(target: GithubTarget): Promise<boolean> {
  try {
    await call(target, `/repos/${target.owner}/${target.repo}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a branch, commit every file onto it in one commit, and open a pull request.
 *
 * Idempotent in the way that matters on a stage: if the branch already exists it is moved to
 * the new commit rather than failing, and if a pull request is already open from it, that one
 * is returned instead of a second being opened. Running the demo twice must not leave two PRs
 * saying the same thing.
 */
export async function openPullRequest(
  target: GithubTarget,
  input: { baseBranch: string; branch: string; title: string; body: string; files: CommitFile[]; message: string },
): Promise<OpenedPr> {
  const repo = `/repos/${target.owner}/${target.repo}`;

  const base = await call<{ object: { sha: string } }>(target, `${repo}/git/ref/heads/${input.baseBranch}`);
  const baseCommit = await call<{ tree: { sha: string } }>(target, `${repo}/git/commits/${base.object.sha}`);

  const blobs = await Promise.all(
    input.files.map(async (file) => {
      const blob = await call<{ sha: string }>(target, `${repo}/git/blobs`, {
        method: 'POST',
        body: { content: file.contents, encoding: 'utf-8' },
      });
      return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha };
    }),
  );

  const tree = await call<{ sha: string }>(target, `${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseCommit.tree.sha, tree: blobs },
  });

  const commit = await call<{ sha: string }>(target, `${repo}/git/commits`, {
    method: 'POST',
    body: { message: input.message, tree: tree.sha, parents: [base.object.sha] },
  });

  try {
    await call(target, `${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${input.branch}`, sha: commit.sha },
    });
  } catch (err) {
    // 422 here means the ref exists — a second run of the same migration. Move it rather than
    // failing: the alternative is a demo that works once per branch name.
    if (!(err instanceof GithubError && err.status === 422)) throw err;
    await call(target, `${repo}/git/refs/heads/${input.branch}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: true },
    });
  }

  const existing = await call<{ number: number; html_url: string }[]>(
    target,
    `${repo}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${input.branch}`)}`,
  );
  if (existing.length > 0) return { number: existing[0].number, url: existing[0].html_url };

  const pr = await call<{ number: number; html_url: string }>(target, `${repo}/pulls`, {
    method: 'POST',
    body: { title: input.title, head: input.branch, base: input.baseBranch, body: input.body },
  });
  return { number: pr.number, url: pr.html_url };
}

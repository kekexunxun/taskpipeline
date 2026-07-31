export type GitLabProfile = { baseUrl: string; token: string; projectId: string | number };
export type GitLabMergeRequest = { web_url: string; iid: number; state: "opened" | "merged" | "closed" | string };

export function parseGitLabRemote(remoteUrl: string): { baseUrl: string; projectId: string } | undefined {
  const cleanProject = (value: string) => value.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/i, "");
  try {
    if (/^https?:\/\//i.test(remoteUrl)) { const url = new URL(remoteUrl); return { baseUrl: `${url.protocol}//${url.host}`, projectId: cleanProject(url.pathname) }; }
    if (/^ssh:\/\//i.test(remoteUrl)) { const url = new URL(remoteUrl); return { baseUrl: `https://${url.hostname}`, projectId: cleanProject(url.pathname) }; }
  } catch { return undefined; }
  const ssh = remoteUrl.match(/^git@([^:]+):(.+)$/i);
  if (ssh) return { baseUrl: `https://${ssh[1]!}`, projectId: cleanProject(ssh[2]!) };
  return undefined;
}

export class GitLabService {
  constructor(private readonly profile: GitLabProfile, private readonly fetcher: typeof fetch = fetch) {}
  private url(path: string): string { return `${this.profile.baseUrl.replace(/\/$/, "")}/api/v4${path}`; }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(this.url(path), { ...init, headers: { "PRIVATE-TOKEN": this.profile.token, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    if (!response.ok) throw new Error(`GitLab request failed (${response.status}): ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  createMergeRequest(input: { sourceBranch: string; targetBranch: string; title: string; description: string }): Promise<GitLabMergeRequest> {
    return this.request(`/projects/${encodeURIComponent(this.profile.projectId)}/merge_requests`, { method: "POST", body: JSON.stringify({ source_branch: input.sourceBranch, target_branch: input.targetBranch, title: input.title, description: input.description }) });
  }
  getMergeRequest(iid: number): Promise<GitLabMergeRequest> { return this.request(`/projects/${encodeURIComponent(this.profile.projectId)}/merge_requests/${iid}`); }
}

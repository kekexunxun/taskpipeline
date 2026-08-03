import type { JiraMapping, Task, TaskState } from "@coding-agent/core";

const defaultFields = {
  key: "key",
  title: "fields.summary",
  description: "fields.description",
  keywords: "fields.labels",
  acceptanceCriteria: "fields.acceptanceCriteria",
  status: "fields.status.name",
  sourceUrl: "self"
} as const;

function valueAt(input: unknown, path: string): unknown {
  if (!path) return input;
  return path.split(".").reduce<unknown>((value, segment) => {
    if (Array.isArray(value) && /^\d+$/.test(segment)) return value[Number(segment)];
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, input);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.name === "string") return record.name;
    if (Array.isArray(record.content)) return record.content.map(asText).filter(Boolean).join("\n");
  }
  return String(value);
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const text = asText(value);
  return text ? text.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean) : [];
}

export type JiraTaskInput = Pick<Task, "taskKey" | "source" | "sourceUrl" | "title" | "description" | "keywords" | "acceptanceCriteria" | "state">;

export function mapJiraTasks(response: unknown, mapping: JiraMapping = {}): JiraTaskInput[] {
  const content = valueAt(response, "content");
  let source: unknown = response;
  if (Array.isArray(content)) {
    const text = content.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text") as Record<string, unknown> | undefined;
    if (typeof text?.text === "string") {
      try { source = JSON.parse(text.text); } catch { source = text.text; }
    }
  }
  const items = valueAt(source, mapping.itemsPath ?? "issues");
  const rows = Array.isArray(items) ? items : Array.isArray(source) ? source : [];
  const fields = { ...defaultFields, ...(mapping.fields ?? {}) };
  const read = (row: unknown, field: keyof typeof defaultFields, fallbackPath: string): unknown => {
    const value = valueAt(row, fields[field]);
    if (value !== undefined && value !== null) return value;
    return mapping.fields?.[field] ? undefined : valueAt(row, fallbackPath);
  };
  return rows.flatMap((row) => {
    const jiraKey = asText(read(row, "key", "jira_key"));
    const title = asText(read(row, "title", "summary"));
    if (!jiraKey || !title) return [];
    const remoteStatus = asText(read(row, "status", "status"));
    const state: TaskState = mapping.statusMap?.[remoteStatus] ?? "draft";
    const sourceUrl = asText(read(row, "sourceUrl", "url")) || undefined;
    return [{ taskKey: jiraKey, source: "jira", ...(sourceUrl ? { sourceUrl } : {}), title, description: asText(read(row, "description", "description")), keywords: asList(read(row, "keywords", "labels")), acceptanceCriteria: asList(read(row, "acceptanceCriteria", "acceptance_criteria")), state }];
  });
}

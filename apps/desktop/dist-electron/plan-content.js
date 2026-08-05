export function sdkResultText(result, errors) {
    if (result == null) {
        return Array.isArray(errors) ? errors.map(String).join("\n") || undefined : undefined;
    }
    if (typeof result === "string")
        return result;
    try {
        return JSON.stringify(result);
    }
    catch {
        return String(result);
    }
}
function structuredContent(value) {
    if (typeof value === "string")
        return value.trim();
    if (value == null)
        return "";
    if (Array.isArray(value)) {
        return value.map((item, index) => {
            const content = structuredContent(item);
            return content ? `${index + 1}. ${content}` : "";
        }).filter(Boolean).join("\n");
    }
    if (typeof value !== "object")
        return String(value);
    const record = value;
    for (const key of ["markdown", "text", "content"]) {
        const preferred = structuredContent(record[key]);
        if (preferred)
            return preferred;
    }
    return Object.entries(record).map(([key, item]) => {
        const content = structuredContent(item);
        return content ? `## ${key.replace(/_/g, " ")}\n\n${content}` : "";
    }).filter(Boolean).join("\n\n");
}
export function parsePlanDecision(texts) {
    for (const text of [...texts].reverse()) {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start < 0 || end <= start)
            continue;
        try {
            const value = JSON.parse(text.slice(start, end + 1));
            if (["changes_required", "already_satisfied"].includes(value.outcome ?? "")) {
                const content = structuredContent(value.plan ?? value.summary);
                if (content)
                    return { outcome: value.outcome, content };
            }
        }
        catch { /* Older agents may return prose instead of the requested JSON. */ }
    }
    const content = [...texts].sort((a, b) => b.length - a.length)[0]?.trim() ?? "";
    if (!content)
        throw new Error("Agent 未返回有效计划");
    const alreadySatisfied = /(?:结论\s*[:：]?\s*)?(?:该任务|当前代码|代码)?(?:已经|已)(?:完成|满足)|无需(?:任何)?(?:代码)?修改|无需改动|already satisfied|no (?:code )?changes? (?:are )?required/i.test(content);
    return { outcome: alreadySatisfied ? "already_satisfied" : "changes_required", content };
}
//# sourceMappingURL=plan-content.js.map
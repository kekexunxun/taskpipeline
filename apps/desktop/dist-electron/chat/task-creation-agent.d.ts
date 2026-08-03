import type { AtlassianClientFactory } from "@coding-agent/integrations";
export type JiraCreatedTask = {
    jiraKey: string;
    summary: string;
    projectKey: string;
    issueType: string;
};
export type JiraCreateInput = {
    projectKey: string;
    issueTypeId?: string;
    issueTypeName: string;
    summary: string;
    description?: string;
    componentId?: string;
    componentName?: string;
    priorityId?: string;
    taskLevelId?: string;
    taskCategoryId?: string;
    sprintId?: number;
    originalEstimate?: string;
    remainingEstimate?: string;
    assignee?: string;
    reporter?: string;
    additionalFields?: Record<string, unknown>;
};
export declare class JiraTaskCreationAgent {
    private readonly factory;
    private jira?;
    private confluence?;
    private jiraTools?;
    private confluenceTools?;
    private readonly confirmedCustomFields;
    private schemaLoaded;
    createdTask?: JiraCreatedTask;
    constructor(factory: AtlassianClientFactory);
    get jiraConfigured(): boolean;
    get confluenceConfigured(): boolean;
    get systemPrompt(): string;
    getCreationSchema(input: {
        projectKey?: string;
        issueTypeId?: string;
        issueTypeName?: string;
    }): Promise<unknown>;
    searchConfluence(input: {
        query: string;
        limit?: number;
    }): Promise<unknown>;
    getConfluencePage(input: {
        pageId: string;
    }): Promise<unknown>;
    createJiraIssue(input: JiraCreateInput): Promise<JiraCreatedTask>;
    close(): void;
    private getJiraClient;
    private getConfluenceClient;
    private getJiraTools;
    private getConfluenceTools;
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@task-pipeline/core";

/**
 * DockerToolRouter 降级测试：
 * - docker CLI 可用（docker info 成功）但镜像拉取/容器启动失败（如 registry 403）时，
 *   工具必须自动回退到本机执行，而不是每次调用都抛「Docker sandbox is unavailable」。
 */

const startMock = vi.fn();

vi.mock("@task-pipeline/integrations", () => ({
  DockerSandbox: class {
    available = vi.fn(async () => true);
    start = startMock;
    stop = vi.fn(async () => undefined);
    exec = vi.fn(async () => Buffer.from(""));
    execResult = vi.fn(async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 }));
    execAt = vi.fn(async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 }));
    execStreaming = vi.fn(async () => ({ exitCode: 0 }));
  }
}));

// pi-coding-agent 的 create*Tool：返回带 execute 的 tool 对象
vi.mock("@earendil-works/pi-coding-agent", () => {
  const makeTool = (name: string) => ({
    name,
    description: "",
    parameters: {},
    execute: vi.fn(async () => ({ content: [{ type: "text", text: `${name}:local` }] }))
  });
  return {
    createReadTool: (_cwd: string, options?: unknown) => (options ? { ...makeTool("read-docker") } : { ...makeTool("read") }),
    createWriteTool: (_cwd: string, options?: unknown) => (options ? { ...makeTool("write-docker") } : { ...makeTool("write") }),
    createEditTool: (_cwd: string, options?: unknown) => (options ? { ...makeTool("edit-docker") } : { ...makeTool("edit") }),
    createBashTool: (_cwd: string, options?: unknown) => (options ? { ...makeTool("bash-docker") } : { ...makeTool("bash") }),
    createLsTool: (_cwd: string, options?: unknown) => (options ? { ...makeTool("ls-docker") } : { ...makeTool("ls") }),
    createFindTool: (_cwd: string, options?: unknown) => (options ? { ...makeTool("find-docker") } : { ...makeTool("find") }),
    createGrepTool: (_cwd: string) => makeTool("grep")
  };
});

const { DockerToolRouter } = await import("./sandbox.js");

function makeTask(id = "task-1"): Task {
  return {
    id,
    source: "local",
    title: "t",
    description: "",
    keywords: [],
    acceptanceCriteria: [],
    state: "implementing",
    reviewStatus: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function makeStore(task?: Task): TaskStore {
  return {
    getSetting: () => undefined,
    setSetting: () => undefined,
    listTaskRepositories: () =>
      task ? [{ repositoryId: "r1", name: "r", localPath: "/tmp/repo", baseBranch: "main" }] : [],
    addEvent: vi.fn()
  } as unknown as TaskStore;
}

function makePi() {
  const tools = new Map<string, { execute: (id: string, params: unknown, signal?: AbortSignal, update?: unknown) => Promise<unknown> }>();
  const handlers = new Map<string, () => Promise<unknown>>();
  return {
    registerTool: (tool: { name: string; execute: unknown }) => {
      tools.set(tool.name, { execute: tool.execute as never });
    },
    on: (event: string, handler: () => Promise<unknown>) => {
      handlers.set(event, handler);
    },
    tools,
    handlers
  };
}

describe("DockerToolRouter degrade-to-host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startMock.mockReset();
  });

  it("reports docker mode when docker is available", async () => {
    const router = new DockerToolRouter(makeStore(), () => undefined, "docker");
    await expect(router.check()).resolves.toBe("docker");
  });

  it("degrades to host when container start fails (e.g. registry 403)", async () => {
    startMock.mockRejectedValueOnce(new Error("Unable to start sandbox: 403 Forbidden"));
    const store = makeStore(makeTask());
    const router = new DockerToolRouter(store, () => makeTask(), "docker");

    // 第一次 container()：start 失败 → 降级，返回 undefined
    await expect(router.container()).resolves.toBeUndefined();
    // 降级持久：后续 check() 直接是 host，不再重试 docker
    await expect(router.check()).resolves.toBe("host");
    // 写了一条「回退本机」的任务事件
    expect((store.addEvent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "status", title: "执行环境：回退本机" })
    );
    // 后续容器不再启动
    startMock.mockClear();
    await router.container();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("routes tools to local implementations after degradation (no docker errors surface)", async () => {
    startMock.mockRejectedValue(new Error("Unable to start sandbox: 403 Forbidden"));
    const router = new DockerToolRouter(makeStore(makeTask()), () => makeTask(), "docker");
    const pi = makePi();
    router.register(pi as never, "/tmp/repo");

    const readTool = pi.tools.get("read");
    expect(readTool).toBeDefined();
    // 第一次执行：docker 模式 → 容器启动失败 → 回退本地 read 工具，不抛错
    const result = await readTool!.execute("id-1", { path: "/tmp/repo/a.ts" }, undefined, undefined);
    expect(result).toMatchObject({ content: [{ type: "text", text: "read:local" }] });
    // 降级后再次执行仍走本地
    const result2 = await readTool!.execute("id-2", { path: "/tmp/repo/b.ts" }, undefined, undefined);
    expect(result2).toMatchObject({ content: [{ type: "text", text: "read:local" }] });
  });
});

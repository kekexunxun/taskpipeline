import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanModeContext } from "@coding-agent/core";

interface QueryCall {
  prompt: string;
  options: Record<string, unknown> & { abortController?: AbortController };
}

const queryCalls: QueryCall[] = [];
const messageIterators: Array<AsyncIterable<unknown>> = [];

function asyncIterFromArray<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < items.length) return { value: items[index++] as T, done: false };
          return { value: undefined as unknown as T, done: true };
        }
      };
    }
  };
}

vi.mock("@qoder-ai/qoder-agent-sdk", () => ({
  accessToken: (token: string) => ({ token }),
  query: (args: { prompt: string; options?: Record<string, unknown> }) => {
    queryCalls.push({ prompt: args.prompt, options: (args.options ?? {}) as QueryCall["options"] });
    const iter = messageIterators.shift() ?? asyncIterFromArray<unknown>([]);
    const ac = (args.options?.abortController ?? null) as AbortController | null;
    return {
      [Symbol.asyncIterator]() {
        const inner = iter[Symbol.asyncIterator]();
        return {
          async next() {
            // 如果已经 abort,直接 reject
            if (ac?.signal.aborted) {
              const reason = ac.signal.reason ?? new Error("aborted");
              throw reason instanceof Error ? reason : new Error(String(reason));
            }
            // 用 abort signal race 包装 inner.next() — 若 abort 触发,抛错退出 for-await
            if (ac) {
              return new Promise((resolve, reject) => {
                const onAbort = () => {
                  const reason = ac.signal.reason ?? new Error("aborted");
                  reject(reason instanceof Error ? reason : new Error(String(reason)));
                };
                ac.signal.addEventListener("abort", onAbort, { once: true });
                inner.next().then(
                  (value) => { ac.signal.removeEventListener("abort", onAbort); resolve(value); },
                  (error) => { ac.signal.removeEventListener("abort", onAbort); reject(error); }
                );
              });
            }
            return inner.next();
          },
          async return() { return { value: undefined, done: true }; }
        };
      },
      async close() { /* noop */ }
    };
  }
}));

const { QoderPlanModeProvider } = await import("./qoder-plan-mode.js");

const TEST_CTX: PlanModeContext = {
  task: {
    title: "T",
    description: "D",
    acceptanceCriteria: ["AC1", "AC2"]
  }
};

const TEST_CTX_WITH_FEEDBACK: PlanModeContext = { task: TEST_CTX.task, feedback: "再细化下" };

beforeEach(() => {
  queryCalls.length = 0;
  messageIterators.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QoderPlanModeProvider.instruction", () => {
  it("包含任务标题、描述、验收标准", () => {
    const provider = new QoderPlanModeProvider(() => "tok", () => undefined);
    const text = provider.instruction(TEST_CTX);
    expect(text).toContain("T");
    expect(text).toContain("D");
    expect(text).toContain("- AC1");
    expect(text).toContain("- AC2");
    expect(text).toContain("禁止修改文件");
    expect(text).toContain("already_satisfied");
    expect(text).toContain("changes_required");
  });

  it("有 feedback 时追加调整意见段", () => {
    const provider = new QoderPlanModeProvider(() => "tok", () => undefined);
    const text = provider.instruction(TEST_CTX_WITH_FEEDBACK);
    expect(text).toContain("上一次计划的调整意见");
    expect(text).toContain("再细化下");
  });
});

describe("QoderPlanModeProvider.parseOutput", () => {
  const provider = new QoderPlanModeProvider(() => "tok", () => undefined);
  it("解析 already_satisfied", () => {
    expect(provider.parseOutput('{"outcome":"already_satisfied","summary":"x"}'))
      .toEqual({ outcome: "already_satisfied", summary: "x" });
  });
  it("解析 changes_required", () => {
    expect(provider.parseOutput('前缀 {"outcome":"changes_required","plan":"do X"} 后缀'))
      .toEqual({ outcome: "changes_required", plan: "do X" });
  });
  it("garbled 走 unparsed", () => {
    expect(provider.parseOutput("garbled")).toEqual({ outcome: "unparsed", raw: "garbled" });
  });
  it("缺 outcome 字段走 unparsed", () => {
    expect(provider.parseOutput('{"foo":1}')).toEqual({ outcome: "unparsed", raw: '{"foo":1}' });
  });
});

describe("QoderPlanModeProvider.runPlan", () => {
  it("token 缺失时抛错", async () => {
    const provider = new QoderPlanModeProvider(() => undefined, () => undefined);
    await expect(provider.runPlan(TEST_CTX)).rejects.toThrow(/Qoder Token/);
  });

  it("调用 query 时 permissionMode=plan + auth=accessToken + cwd 透传", async () => {
    messageIterators.push(asyncIterFromArray<unknown>([
      { type: "result", session_id: "sess-1", result: '{"outcome":"changes_required","plan":"do X"}' }
    ]));
    const tokenProvider = vi.fn(() => "tok-123");
    const resolveModel = vi.fn(() => "claude-sonnet-4.5");
    const provider = new QoderPlanModeProvider(tokenProvider, resolveModel);
    const result = await provider.runPlan(TEST_CTX, { cwd: "/tmp/workspace" });
    expect(result).toEqual({ outcome: "changes_required", plan: "do X" });

    expect(queryCalls).toHaveLength(1);
    const call = queryCalls[0]!;
    expect(call.options.permissionMode).toBe("plan");
    expect(call.options.persistSession).toBe(true);
    expect(call.options.includePartialMessages).toBe(false);
    expect(call.options.cwd).toBe("/tmp/workspace");
    expect(call.options.model).toBe("claude-sonnet-4.5");
    expect(call.options.abortController).toBeInstanceOf(AbortController);
  });

  it("无 cwd 时 fallback 到 process.cwd()", async () => {
    messageIterators.push(asyncIterFromArray<unknown>([
      { type: "result", session_id: "sess-2", result: '{"outcome":"already_satisfied","summary":"ok"}' }
    ]));
    const provider = new QoderPlanModeProvider(() => "tok", () => undefined);
    await provider.runPlan(TEST_CTX);
    const call = queryCalls[0]!;
    expect(call.options.cwd).toBe(process.cwd());
  });

  it("options.model 优先于 resolveModel(ctx)", async () => {
    messageIterators.push(asyncIterFromArray<unknown>([
      { type: "result", result: '{"outcome":"changes_required","plan":"x"}' }
    ]));
    const resolveModel = vi.fn(() => "default-model");
    const provider = new QoderPlanModeProvider(() => "tok", resolveModel);
    await provider.runPlan(TEST_CTX, { model: "override-model" });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(queryCalls[0]!.options.model).toBe("override-model");
  });

  it("options.signal abort 会触发 abortController.abort", async () => {
    // 准备一个永不结束的 iterator,但 mock query() 里的 next() 会响应 abortController。
    const neverEnds: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() { return new Promise(() => { /* never resolves unless aborted — mock 拒绝拦截 */ }); }
        };
      }
    };
    messageIterators.push(neverEnds);
    const provider = new QoderPlanModeProvider(() => "tok", () => undefined);
    const controller = new AbortController();
    const promise = provider.runPlan(TEST_CTX, { signal: controller.signal });
    controller.abort(new Error("外部取消"));
    await expect(promise).rejects.toBeDefined();
    // 验证 abortController 已经被 abort
    const ac = queryCalls[0]!.options.abortController!;
    expect(ac.signal.aborted).toBe(true);
  });

  it("hardTimeoutMs 触发 abortController.abort", async () => {
    // 迭代器永不结束：hardTimer 触发 abort 后，mock query() 的 next() 通过 abort race reject，
    // for-await 抛错 → runPlan reject。与上方 options.signal abort 测试同一套机制。
    const neverEnds: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() { return new Promise(() => { /* never resolves unless aborted — mock 拒绝拦截 */ }); }
        };
      }
    };
    messageIterators.push(neverEnds);
    const provider = new QoderPlanModeProvider(() => "tok", () => undefined);
    const promise = provider.runPlan(TEST_CTX, { hardTimeoutMs: 20 });
    await expect(promise).rejects.toBeDefined();
    const ac = queryCalls[0]!.options.abortController!;
    expect(ac.signal.aborted).toBe(true);
  });

  it("多次 text blocks 也兼容", async () => {
    messageIterators.push(asyncIterFromArray<unknown>([
      { type: "assistant", message: { content: [{ type: "text", text: "partial " }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "more" }] } },
      { type: "result", result: '{"outcome":"changes_required","plan":"do X"}' }
    ]));
    const provider = new QoderPlanModeProvider(() => "tok", () => undefined);
    const result = await provider.runPlan(TEST_CTX);
    expect(result).toEqual({ outcome: "changes_required", plan: "do X" });
  });
});

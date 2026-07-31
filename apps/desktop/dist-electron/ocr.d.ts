export declare function resolveBundledOcrBinary(): string | undefined;
export declare function resolveOcrBinary(): string;
export type OcrRunResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
    failed?: boolean;
    reason?: string;
    shortMessage?: string;
};
/**
 * 在 electron 打包后,沙盒里没有 PATH 上的 node,直接 spawn .js 会失败。
 * 用 electron 自带的 process.execPath + ELECTRON_RUN_AS_NODE=1 当作 node 用。
 *
 * 同时把 HOME 重定向到 userData,防止 ocr 尝试写 ~/.opencodereview/sessions
 * 时被 macOS 沙盒拒绝(EACCES / "operation not permitted")。
 */
export declare function createOcrRunner(): (binary: string, args: string[], cwd: string) => Promise<OcrRunResult>;

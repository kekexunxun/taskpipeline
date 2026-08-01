import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  children: ReactNode;
  /** 显示在错误卡上方的定位文字，例如 "对话面板加载失败" */
  scope?: string;
  /** 自定义 fallback */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * 轻量 Error Boundary：捕获子树渲染错误并显示降级 UI，避免整页白屏。
 * 单击"重试"会重置 state 并重新挂载子树。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", this.props.scope ?? "root", error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="grid h-full place-items-center bg-background px-6">
        <div className="grid max-w-sm gap-3 text-center">
          <div className="mx-auto grid size-9 place-items-center rounded-md border bg-card text-muted-foreground">
            <AlertTriangleIcon size={16} />
          </div>
          <h2 className="text-sm font-semibold tracking-tight">
            {this.props.scope ?? "页面遇到问题"}
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            {error.message || "未知错误"}
          </p>
          <Button size="sm" className="mx-auto h-7 px-2.5" onClick={this.reset}>
            <RotateCcwIcon size={11} />
            重试
          </Button>
        </div>
      </div>
    );
  }
}

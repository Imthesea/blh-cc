import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** 顶层错误边界：任何子组件抛错时展示可读错误，避免白屏。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <div className="error-banner">应用发生错误：{this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

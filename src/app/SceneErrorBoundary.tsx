import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Surfaces asset/manifest failures instead of leaving a blank canvas — a
 * missing GLB node has to name itself on screen (rdd.md 22.3).
 */
export class SceneErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Turntable scene failed:", error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <p className="scene-error" role="alert">
        {this.state.message}
      </p>
    );
  }
}

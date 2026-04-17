import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  componentDidCatch(err: Error) {
    console.error("UI error:", err);
  }

  render() {
    if (this.state.err) {
      return (
        <div className="boot-error" role="alert">
          <strong>UI crashed.</strong> {this.state.err.message}
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

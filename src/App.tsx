import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type PingResult = {
  ok: boolean;
  timestamp: number;
  processing_version: number;
};

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; ping: PingResult }
  | { kind: "error"; message: string };

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<PingResult>("ping")
      .then((ping) => {
        if (!cancelled) setStatus({ kind: "ok", ping });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setStatus({ kind: "error", message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ padding: "2rem", fontSize: "1.1rem" }}>
      <h1 style={{ marginTop: 0 }}>wholabass</h1>
      <SidecarStatus status={status} />
    </main>
  );
}

function SidecarStatus({ status }: { status: Status }) {
  switch (status.kind) {
    case "idle":
    case "loading":
      return <p style={{ opacity: 0.7 }}>sidecar: starting...</p>;
    case "ok": {
      const ts = new Date(status.ping.timestamp * 1000).toISOString();
      return (
        <p>
          sidecar: ok ({ts}) · processing v{status.ping.processing_version}
        </p>
      );
    }
    case "error":
      return (
        <p style={{ color: "#ff7676" }}>sidecar error: {status.message}</p>
      );
  }
}

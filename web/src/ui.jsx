import { useEffect, useState } from "react";

export function when(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function RiskBadge({ level }) {
  const label = { low: "Low", moderate: "Moderate", high: "High", extreme: "Extreme", unknown: "Unknown" }[level] ?? level;
  return <span className={`badge risk-${level || "unknown"}`}>{label}</span>;
}

export function useLoad(loader, deps) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: "" }));
    loader()
      .then((data) => live && setState({ loading: false, error: "", data }))
      .catch((error) => live && setState({ loading: false, error: error.message, data: null }));
    return () => { live = false; };
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((value) => value + 1) };
}

export async function run(action, onOk, onErr) {
  try {
    const result = await action();
    onOk?.(result);
  } catch (error) {
    onErr(error.message);
  }
}

import { useEffect, useState, type ComponentProps } from "react";
import { TasksPanel } from "./TasksPanel";

type Props = Omit<ComponentProps<typeof TasksPanel>, "now"> & {
  /** Something is running, so durations count up. */
  running: boolean;
};

const TICK_MS = 1000;

/**
 * Owns the panel's clock so a once-a-second tick re-renders only the panel, never
 * the sidebar around it. It ticks only while something is running.
 */
export function TasksPanelLive({ running, ...panel }: Props) {
  const [now, setNow] = useState(() => Date.now());
  // Work starting again refreshes the clock before that render shows, never a frame later.
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    if (running) setNow(Date.now());
  }
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);
  return <TasksPanel {...panel} now={running ? now : Date.now()} />;
}

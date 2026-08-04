import { useEffect } from "react";
import Workbench from "./layout/Workbench";
import { useAgentSession } from "./hooks/useAgentSession";
import { useUpdateStore } from "./store/update-store";
import { useSessionStore } from "./store/session-store";
import { useSkillStore } from "./store/skill-store";
import { useWorkspaceStore } from "./store/workspace-store";
import { useAgentStore } from "./store/agent-store";

/**
 * Load all core desktop data (workspace, sessions, skills, model/state).
 * Idempotent — called on mount AND again when the main process signals the
 * SDK is ready (pi:ready), so an early call that raced the SDK init is retried
 * and the panels can never be left empty by the startup race.
 */
async function loadInitialData(): Promise<void> {
  try {
    await Promise.all([
      useWorkspaceStore.getState().load(),
      useSessionStore.getState().load(),
      useSkillStore.getState().load(),
    ]);
    const state = await window.piDesk.getState();
    if (state?.model) useAgentStore.getState().setModel(state.model);
    if (state?.thinkingLevel) useAgentStore.getState().setThinkingLevel(state.thinkingLevel);
  } catch (err) {
    console.error("Initial data load failed (will retry on pi:ready):", err);
  }
}

export default function App() {
  useAgentSession();

  // Subscribe to auto-update state broadcasts + load core data once. An early
  // load may race the (slow, synchronous) SDK init on the main process; pi:ready
  // fires once it is done, so we reload there to guarantee populated panels.
  useEffect(() => {
    useUpdateStore.getState().init();
    void loadInitialData();
    const offReady = window.piDesk.onReady(() => void loadInitialData());
    return () => offReady();
  }, []);

  return <Workbench />;
}

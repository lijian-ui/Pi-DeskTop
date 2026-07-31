import { useEffect } from "react";
import Workbench from "./layout/Workbench";
import { useAgentSession } from "./hooks/useAgentSession";
import { useUpdateStore } from "./store/update-store";

export default function App() {
  useAgentSession();

  // Subscribe to auto-update state broadcasts from the main process once.
  useEffect(() => {
    useUpdateStore.getState().init();
  }, []);

  return <Workbench />;
}

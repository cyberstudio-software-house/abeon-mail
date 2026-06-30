import { useCallback, useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

type UpdateStatus = "idle" | "checking" | "uptodate" | "available" | "downloading" | "error";

type AvailableUpdate = { version: string; downloadAndInstall: () => Promise<void> };

type UseAppUpdateOptions = { checkOnMount?: boolean };

export function useAppUpdate({ checkOnMount = false }: UseAppUpdateOptions = {}) {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [newVersion, setNewVersion] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    let active = true;
    getVersion()
      .then((v) => active && setVersion(v))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const checkForUpdate = useCallback(async () => {
    setError("");
    setStatus("checking");
    try {
      const update = await check();
      if (update && update.available) {
        setPending(update as AvailableUpdate);
        setNewVersion(update.version);
        setStatus("available");
      } else {
        setStatus("uptodate");
      }
    } catch {
      setStatus("error");
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!pending) return;
    setError("");
    setStatus("downloading");
    try {
      await pending.downloadAndInstall();
      await relaunch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [pending]);

  useEffect(() => {
    if (checkOnMount) void checkForUpdate();
  }, [checkOnMount, checkForUpdate]);

  return { version, status, newVersion, error, checkForUpdate, installUpdate };
}

import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

type UpdateStatus = "idle" | "checking" | "uptodate" | "available" | "downloading" | "error";

type AvailableUpdate = { version: string; downloadAndInstall: () => Promise<void> };

export function useAppUpdate() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [newVersion, setNewVersion] = useState("");
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

  async function checkForUpdate() {
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
  }

  async function installUpdate() {
    if (!pending) return;
    setStatus("downloading");
    try {
      await pending.downloadAndInstall();
      await relaunch();
    } catch {
      setStatus("error");
    }
  }

  return { version, status, newVersion, checkForUpdate, installUpdate };
}

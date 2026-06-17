import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "./bindings";
import type { Account, Endpoints } from "./bindings";

type ResultOk<T> = { status: "ok"; data: T };
type ResultErr = { status: "error"; error: string };
type Result<T> = ResultOk<T> | ResultErr;

function unwrap<T>(result: Result<T>): T {
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
}

export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => commands.listAccounts().then(unwrap),
  });
}

export function useFolders(accountId: number | null) {
  return useQuery({
    queryKey: ["folders", accountId],
    queryFn: () => commands.listFolders(accountId!).then(unwrap),
    enabled: accountId != null,
  });
}

export function useMessages(folderId: number | null) {
  return useQuery({
    queryKey: ["messages", folderId],
    queryFn: () => commands.listMessages(folderId!, 100, 0).then(unwrap),
    enabled: folderId != null,
  });
}

export function useMessageBody(messageId: number | null) {
  return useQuery({
    queryKey: ["body", messageId],
    queryFn: () => commands.getMessageBody(messageId!).then(unwrap),
    enabled: messageId != null,
  });
}

export function useResolveEndpoints() {
  return useMutation({
    mutationFn: (email: string) => commands.resolveEndpoints(email),
  });
}

export function useAddAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      email,
      displayName,
      password,
      endpoints,
    }: {
      email: string;
      displayName: string;
      password: string;
      endpoints: Endpoints;
    }) => commands.addAccount(email, displayName, password, endpoints).then(unwrap),
    onSuccess: (account: Account) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["folders", account.id] });
    },
  });
}

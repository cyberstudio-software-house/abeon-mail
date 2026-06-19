import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { commands } from "./bindings";
import type { Account, Endpoints, Label, MessageFlag, OutgoingMessage, SmartFolderKind, SmartMessageRow } from "./bindings";
import { useUiStore } from "../app/store";

type ResultOk<T> = { status: "ok"; data: T };
type ResultErr = { status: "error"; error: string };
type Result<T> = ResultOk<T> | ResultErr;

function unwrap<T>(result: Result<T>): T {
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
}

export function useThreads(folderId: number | null) {
  return useQuery({
    queryKey: ["threads", folderId],
    queryFn: () => commands.listThreads(folderId!, 100, 0).then(unwrap),
    enabled: folderId != null,
  });
}

export function useThreadMessages(threadId: number | null) {
  return useQuery({
    queryKey: ["thread-messages", threadId],
    queryFn: () => commands.listThreadMessages(threadId!).then(unwrap),
    enabled: threadId != null,
  });
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

export function useSetFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, flag, value }: { messageId: number; flag: MessageFlag; value: boolean }) =>
      commands.setMessageFlags(messageId, flag, value).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useMarkSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: number) => commands.markMessageSeen(messageId).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
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

export function useBeginGoogleOauth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.beginGoogleOauth().then(unwrap),
    onSuccess: (account: Account) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["folders", account.id] });
    },
  });
}

export function useStartReply() {
  return useMutation({
    mutationFn: ({ messageId, mode }: { messageId: number; mode: string }) =>
      commands.startReply(messageId, mode).then(unwrap),
  });
}

export function useSaveDraft() {
  return useMutation({
    mutationFn: ({
      accountId,
      draftId,
      message,
    }: {
      accountId: number;
      draftId: number | null;
      message: OutgoingMessage;
    }) => commands.saveDraft(accountId, draftId, message).then(unwrap),
  });
}

export function useEnqueueSend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draftId: number) => commands.enqueueSend(draftId).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
  });
}

export function useSmartFolder(kind: SmartFolderKind | null) {
  return useQuery<SmartMessageRow[]>({
    queryKey: ["smart", kind],
    queryFn: () => commands.listSmartFolder(kind!, 100, 0).then(unwrap),
    enabled: kind != null,
  });
}

export function useSearch(query: string) {
  return useQuery<SmartMessageRow[]>({
    queryKey: ["search", query],
    queryFn: () => commands.searchMessages(query, 100, 0).then(unwrap),
    enabled: query.trim().length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useRemoveAccount() {
  const queryClient = useQueryClient();
  const store = useUiStore.getState();
  return useMutation({
    mutationFn: (accountId: number) =>
      commands.removeAccount(accountId).then(unwrap),
    onSuccess: (_data, accountId) => {
      if (store.selectedAccountId === accountId) {
        store.setSelectedAccountId(null);
        store.setSelectedFolderId(null);
      }
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useReorderAccounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: number[]) =>
      commands.reorderAccounts(orderedIds).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useBeginReauth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: number) =>
      commands.beginReauth(accountId).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useLabels() {
  return useQuery<Label[]>({
    queryKey: ["labels"],
    queryFn: () => commands.listLabels().then(unwrap),
  });
}

export function useMessagesByLabel(labelId: number | null) {
  return useQuery<SmartMessageRow[]>({
    queryKey: ["messages-by-label", labelId],
    queryFn: () => commands.listMessagesByLabel(labelId!, 100, 0).then(unwrap),
    enabled: labelId != null,
  });
}

export function useLabelsForMessages(ids: number[]) {
  const sorted = [...ids].sort((a, b) => a - b);
  return useQuery<[number, Label][]>({
    queryKey: ["labels-for-messages", sorted],
    queryFn: () => commands.labelsForMessages(sorted).then(unwrap),
    enabled: sorted.length > 0,
  });
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color: string }) =>
      commands.createLabel(name, color).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
    },
  });
}

export function useRenameLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      commands.renameLabel(id, name).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
    },
  });
}

export function useSetLabelColor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, color }: { id: number; color: string }) =>
      commands.setLabelColor(id, color).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => commands.deleteLabel(id).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}

export function useSetMessageLabels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ labelId, messageIds, applied }: { labelId: number; messageIds: number[]; applied: boolean }) =>
      commands.setMessageLabels(labelId, messageIds, applied).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}

export function useSnooze() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageIds, wakeAt }: { messageIds: number[]; wakeAt: number }) =>
      commands.snoozeMessages(messageIds, wakeAt).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}

export function useUnsnooze() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageIds: number[]) => commands.unsnoozeMessages(messageIds).then(unwrap),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["smart"] });
      queryClient.invalidateQueries({ queryKey: ["labels-for-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages-by-label"] });
    },
  });
}

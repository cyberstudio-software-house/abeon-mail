import { commands } from "./bindings";

export type { Account, ProviderType } from "./bindings";
export { commands };

export async function health(): Promise<string> {
  return commands.appHealth();
}

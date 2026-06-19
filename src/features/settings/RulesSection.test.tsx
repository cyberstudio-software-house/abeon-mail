import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { RulesSection } from "./RulesSection";

const { createRule, setRuleEnabled, deleteRule } = vi.hoisted(() => ({
  createRule: vi.fn(),
  setRuleEnabled: vi.fn(),
  deleteRule: vi.fn(),
}));

const sampleRule = {
  id: 7,
  account_id: 1,
  name: "Work to label",
  enabled: true,
  match_type: "all",
  conditions: [{ field: "from", op: "contains", value: "work.com" }],
  actions: [{ kind: "flag", value: "" }],
  position: 0,
};

vi.mock("../../ipc/queries", () => ({
  useAccounts: () => ({ data: [{ id: 1, email: "a@x.com", display_name: "A", provider_type: "imap_password", color: null, position: 0, requires_reauth: false }] }),
  useLabels: () => ({ data: [{ id: 3, name: "Work", color: "#4f46e5" }] }),
  useRules: () => ({ data: [sampleRule] }),
  useCreateRule: () => ({ mutate: createRule }),
  useUpdateRule: () => ({ mutate: vi.fn() }),
  useSetRuleEnabled: () => ({ mutate: setRuleEnabled }),
  useDeleteRule: () => ({ mutate: deleteRule }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("RulesSection", () => {
  it("lists existing rules", () => {
    const { getByText } = render(<RulesSection />);
    expect(getByText("Work to label")).toBeTruthy();
  });

  it("toggles a rule's enabled state", () => {
    const { getByLabelText } = render(<RulesSection />);
    fireEvent.click(getByLabelText("Enable rule Work to label"));
    expect(setRuleEnabled).toHaveBeenCalledWith({ ruleId: 7, accountId: 1, enabled: false });
  });

  it("deletes a rule", () => {
    const { getByLabelText } = render(<RulesSection />);
    fireEvent.click(getByLabelText("Delete rule Work to label"));
    expect(deleteRule).toHaveBeenCalledWith({ ruleId: 7, accountId: 1 });
  });

  it("adds a condition and action row and creates a rule", () => {
    const { getByLabelText, getByText } = render(<RulesSection />);
    fireEvent.change(getByLabelText("Rule name"), { target: { value: "My rule" } });
    fireEvent.change(getByLabelText("Condition 1 value"), { target: { value: "boss" } });
    fireEvent.click(getByText("Save rule"));
    expect(createRule).toHaveBeenCalledTimes(1);
    const arg = createRule.mock.calls[0][0];
    expect(arg.accountId).toBe(1);
    expect(arg.input.name).toBe("My rule");
    expect(arg.input.conditions.length).toBe(1);
    expect(arg.input.actions.length).toBe(1);
  });

  it("does not save a rule with an empty condition value", () => {
    const { getByText } = render(<RulesSection />);
    fireEvent.click(getByText("Save rule"));
    expect(createRule).not.toHaveBeenCalled();
  });
});

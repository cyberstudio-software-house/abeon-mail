import { useState } from "react";
import { Trash2 } from "lucide-react";
import {
  useAccounts,
  useLabels,
  useRules,
  useCreateRule,
  useUpdateRule,
  useSetRuleEnabled,
  useDeleteRule,
} from "../../ipc/queries";
import type { ConditionField, ConditionOp, RuleActionKind, MatchType } from "../../ipc/bindings";

type DraftCondition = { field: ConditionField; op: ConditionOp; value: string };
type DraftAction = { kind: RuleActionKind; value: string };

const FIELDS: { value: ConditionField; label: string }[] = [
  { value: "from", label: "From" },
  { value: "subject", label: "Subject" },
  { value: "recipient", label: "Recipient" },
  { value: "has_attachment", label: "Has attachment" },
];

const OPS: { value: ConditionOp; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "is", label: "is" },
];

const ACTION_KINDS: { value: RuleActionKind; label: string }[] = [
  { value: "label", label: "Apply label" },
  { value: "mark_read", label: "Mark as read" },
  { value: "flag", label: "Star" },
  { value: "snooze", label: "Snooze (hours)" },
];

function emptyCondition(): DraftCondition {
  return { field: "from", op: "contains", value: "" };
}

function emptyAction(): DraftAction {
  return { kind: "label", value: "" };
}

export function RulesSection() {
  const { data: accounts = [] } = useAccounts();
  const [chosenAccountId, setChosenAccountId] = useState<number | null>(null);
  const accountId = chosenAccountId ?? accounts[0]?.id ?? null;

  const { data: labels = [] } = useLabels();
  const { data: rules = [] } = useRules(accountId);
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const setRuleEnabled = useSetRuleEnabled();
  const deleteRule = useDeleteRule();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [matchType, setMatchType] = useState<MatchType>("all");
  const [conditions, setConditions] = useState<DraftCondition[]>([emptyCondition()]);
  const [actions, setActions] = useState<DraftAction[]>([emptyAction()]);

  function resetEditor() {
    setEditingId(null);
    setName("");
    setMatchType("all");
    setConditions([emptyCondition()]);
    setActions([emptyAction()]);
  }

  function loadRule(id: number) {
    const r = rules.find((x) => x.id === id);
    if (!r) return;
    setEditingId(r.id);
    setName(r.name);
    setMatchType(r.match_type);
    setConditions(r.conditions.length ? r.conditions.map((c) => ({ ...c })) : [emptyCondition()]);
    setActions(r.actions.length ? r.actions.map((a) => ({ ...a })) : [emptyAction()]);
  }

  function save() {
    if (accountId == null) return;
    const cleanConditions = conditions.filter(
      (c) => c.field === "has_attachment" || c.value.trim().length > 0
    );
    if (cleanConditions.length === 0 || actions.length === 0) return;
    const input = {
      name: name.trim() || "Rule",
      enabled: true,
      match_type: matchType,
      conditions: cleanConditions,
      actions,
    };
    if (editingId == null) {
      createRule.mutate({ accountId, input });
    } else {
      updateRule.mutate({ ruleId: editingId, accountId, input });
    }
    resetEditor();
  }

  return (
    <div className="settings-section">
      <div className="settings-account">
        <span className="settings-account__label">Account</span>
        <select
          className="settings-select"
          aria-label="Rules account"
          value={accountId ?? ""}
          onChange={(e) => setChosenAccountId(Number(e.target.value))}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </div>

      {rules.length > 0 && (
        <ul className="rules-settings__list">
          {rules.map((r) => (
            <li key={r.id} className="rules-settings__row">
              <button type="button" className="rules-settings__name" onClick={() => loadRule(r.id)}>
                {r.name}
              </button>
              <label className="rules-settings__enabled">
                <input
                  type="checkbox"
                  aria-label={`Enable rule ${r.name}`}
                  checked={r.enabled}
                  onChange={() =>
                    accountId != null &&
                    setRuleEnabled.mutate({ ruleId: r.id, accountId, enabled: !r.enabled })
                  }
                />
                Enabled
              </label>
              <button
                type="button"
                className="settings-btn settings-btn--icon"
                aria-label={`Delete rule ${r.name}`}
                onClick={() => accountId != null && deleteRule.mutate({ ruleId: r.id, accountId })}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="rules-settings__editor">
        <div className="settings-field">
          <div className="settings-field__label">Rule name</div>
          <input
            type="text"
            className="settings-input"
            aria-label="Rule name"
            placeholder="Rule name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="settings-field">
          <div className="settings-field__label">Match</div>
          <select
            className="settings-select"
            aria-label="Match type"
            value={matchType}
            onChange={(e) => setMatchType(e.target.value as MatchType)}
          >
            <option value="all">all conditions</option>
            <option value="any">any condition</option>
          </select>
        </div>

        <div className="settings-field">
          <div className="settings-field__label">Conditions</div>
          <div className="rules-settings__conditions">
            {conditions.map((c, i) => (
              <div key={i} className="settings-row">
                <select
                  className="settings-select"
                  aria-label={`Condition ${i + 1} field`}
                  value={c.field}
                  onChange={(e) => {
                    const next = [...conditions];
                    next[i] = { ...c, field: e.target.value as ConditionField };
                    setConditions(next);
                  }}
                >
                  {FIELDS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                {c.field === "has_attachment" ? (
                  <select
                    className="settings-select"
                    aria-label={`Condition ${i + 1} value`}
                    value={c.value || "true"}
                    onChange={(e) => {
                      const next = [...conditions];
                      next[i] = { ...c, op: "is", value: e.target.value };
                      setConditions(next);
                    }}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <>
                    <select
                      className="settings-select"
                      aria-label={`Condition ${i + 1} operator`}
                      value={c.op}
                      onChange={(e) => {
                        const next = [...conditions];
                        next[i] = { ...c, op: e.target.value as ConditionOp };
                        setConditions(next);
                      }}
                    >
                      {OPS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      className="settings-input"
                      aria-label={`Condition ${i + 1} value`}
                      value={c.value}
                      onChange={(e) => {
                        const next = [...conditions];
                        next[i] = { ...c, value: e.target.value };
                        setConditions(next);
                      }}
                    />
                  </>
                )}
                {conditions.length > 1 && (
                  <button
                    type="button"
                    className="settings-btn settings-btn--icon"
                    aria-label={`Remove condition ${i + 1}`}
                    onClick={() => setConditions(conditions.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div className="settings-row">
              <button
                type="button"
                className="settings-btn settings-btn--sm"
                onClick={() => setConditions([...conditions, emptyCondition()])}
              >
                Add condition
              </button>
            </div>
          </div>
        </div>

        <div className="settings-field">
          <div className="settings-field__label">Actions</div>
          <div className="rules-settings__actions-list">
            {actions.map((a, i) => (
              <div key={i} className="settings-row">
                <select
                  className="settings-select"
                  aria-label={`Action ${i + 1} kind`}
                  value={a.kind}
                  onChange={(e) => {
                    const next = [...actions];
                    next[i] = { kind: e.target.value as RuleActionKind, value: "" };
                    setActions(next);
                  }}
                >
                  {ACTION_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>{k.label}</option>
                  ))}
                </select>
                {a.kind === "label" && (
                  <select
                    className="settings-select"
                    aria-label={`Action ${i + 1} label`}
                    value={a.value}
                    onChange={(e) => {
                      const next = [...actions];
                      next[i] = { ...a, value: e.target.value };
                      setActions(next);
                    }}
                  >
                    <option value="">Select label…</option>
                    {labels.map((l) => (
                      <option key={l.id} value={String(l.id)}>{l.name}</option>
                    ))}
                  </select>
                )}
                {a.kind === "snooze" && (
                  <input
                    type="number"
                    className="settings-input"
                    aria-label={`Action ${i + 1} hours`}
                    min={1}
                    value={a.value}
                    placeholder="24"
                    onChange={(e) => {
                      const next = [...actions];
                      next[i] = { ...a, value: e.target.value };
                      setActions(next);
                    }}
                  />
                )}
                {actions.length > 1 && (
                  <button
                    type="button"
                    className="settings-btn settings-btn--icon"
                    aria-label={`Remove action ${i + 1}`}
                    onClick={() => setActions(actions.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div className="settings-row">
              <button
                type="button"
                className="settings-btn settings-btn--sm"
                onClick={() => setActions([...actions, emptyAction()])}
              >
                Add action
              </button>
            </div>
          </div>
        </div>

        <div className="rules-settings__editor-actions">
          <button type="button" className="settings-btn" onClick={resetEditor}>
            New rule
          </button>
          <button type="button" className="settings-btn settings-btn--primary" onClick={save}>
            Save rule
          </button>
        </div>
      </div>
    </div>
  );
}

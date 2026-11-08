// browser/app/RuleBuilder.jsx
//
// The advanced replay search: one line per rule,
// [Where / AND / OR] [field] [condition] [value] [×], like a library's
// advanced search and bonkverse.io's Players page. Fields, conditions and
// values come from shared/replayQuery.js (the server reads the same file),
// so picking a field swaps in its conditions and value box: text with a
// match-case toggle, numbers, dates, a list, or nothing (yes/no). Edits are
// a draft until Search.
import React, { useEffect, useRef, useState } from "react";
import { EXAMPLES, FIELD_BY_KEY, FIELD_GROUPS, FIELDS, MAX_RULES } from "../../shared/replayQuery.js";

let nextId = 1;
const blank = (conn = "and") => withDefaults({ id: nextId++, conn, field: "player" });

function withDefaults(rule) {
  const spec = FIELD_BY_KEY[rule.field];
  const first = spec.choices ? spec.choices[0][0] : "";
  return { value: first, value2: first, caseSensitive: false, ...rule, op: rule.op ?? spec.ops[0][0] };
}

/** A rule that can go in the URL (the server drops anything else too). */
function usable(rule) {
  const spec = FIELD_BY_KEY[rule.field];
  if (spec.value === "none") return true;
  if (!rule.value) return false;
  return rule.op !== "between" || !!rule.value2;
}

function ValueInput({ rule, which, onChange, spec }) {
  const value = which === 2 ? rule.value2 : rule.value;
  const label = which === 2 ? "Second value" : "Value";
  const set = (v) => onChange(which === 2 ? { value2: v } : { value: v });
  if (spec.value === "choice") {
    return (
      <label className="qb__select">
        <span className="visually-hidden">{label}</span>
        <select value={value} onChange={(e) => set(e.target.value)}>
          {spec.choices.map(([k, text]) => (
            <option key={k} value={k}>
              {text}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.value === "date") {
    return (
      <label className="qb__input qb__input--date">
        <span className="visually-hidden">{label}</span>
        <input type="date" value={value} min="2025-01-01" onChange={(e) => set(e.target.value)} />
      </label>
    );
  }
  if (spec.value === "number") {
    return (
      <label className="qb__input qb__input--num">
        <span className="visually-hidden">{label}</span>
        <input
          type="number"
          inputMode="numeric"
          min={spec.min}
          max={spec.max}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      </label>
    );
  }
  return (
    <label className="qb__input">
      <span className="visually-hidden">{label}</span>
      <input
        type="text"
        value={value}
        maxLength={100}
        placeholder={rule.field === "player" ? "Username" : "Text"}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
}

function RuleLine({ rule, index, onChange, onRemove, fieldRef }) {
  const spec = FIELD_BY_KEY[rule.field];
  const between = rule.op === "between";
  return (
    <li className="qb__rule">
      <div className="qb__conn">
        {index === 0 ? (
          <span className="qb__where">Where</span>
        ) : (
          <label className="qb__select qb__select--conn">
            <span className="visually-hidden">Join with</span>
            <select value={rule.conn} onChange={(e) => onChange({ conn: e.target.value })}>
              <option value="and">AND</option>
              <option value="or">OR</option>
            </select>
          </label>
        )}
      </div>

      <label className="qb__select qb__field">
        <span className="visually-hidden">Field</span>
        <select
          ref={fieldRef}
          value={rule.field}
          onChange={(e) => onChange(withDefaults({ id: rule.id, conn: rule.conn, field: e.target.value }), true)}
        >
          {FIELD_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {FIELDS.filter((f) => f.group === group).map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="qb__select qb__op">
        <span className="visually-hidden">Condition</span>
        <select value={rule.op} onChange={(e) => onChange({ op: e.target.value })}>
          {spec.ops.map(([k, text]) => (
            <option key={k} value={k}>
              {text}
            </option>
          ))}
        </select>
      </label>

      <div className="qb__value">
        {spec.value !== "none" && <ValueInput rule={rule} which={1} spec={spec} onChange={onChange} />}
        {between && (
          <>
            <span className="qb__and">and</span>
            <ValueInput rule={rule} which={2} spec={spec} onChange={onChange} />
          </>
        )}
        {spec.unit && <span className="qb__unit">{spec.unit}</span>}
        {spec.value === "text" && (
          <label className="qb__case" title="Match case">
            <input
              type="checkbox"
              checked={rule.caseSensitive}
              onChange={(e) => onChange({ caseSensitive: e.target.checked })}
            />
            <span aria-hidden="true">Aa</span>
            <span className="visually-hidden">Match case</span>
          </label>
        )}
      </div>

      <button type="button" className="qb__remove" onClick={onRemove} aria-label={`Remove rule ${index + 1}`}>
        ×
      </button>
    </li>
  );
}

export default function RuleBuilder({ rules, onSearch, onClose }) {
  const [draft, setDraft] = useState(() =>
    rules.length ? rules.map((r) => ({ ...r, id: nextId++ })) : [blank()]
  );
  const focusIndex = useRef(null);
  const fieldRefs = useRef([]);

  useEffect(() => {
    if (focusIndex.current != null) {
      fieldRefs.current[focusIndex.current]?.focus();
      focusIndex.current = null;
    }
  });

  const update = (i, patch) => setDraft((d) => d.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => {
    focusIndex.current = Math.max(0, i - 1);
    setDraft((d) => (d.length > 1 ? d.filter((_, j) => j !== i) : [blank()]));
  };
  const add = () => {
    focusIndex.current = draft.length;
    setDraft((d) => [...d, blank()]);
  };
  const submit = (e) => {
    e.preventDefault();
    onSearch(draft.filter(usable).map(({ id, ...r }) => r));
  };

  return (
    <form id="advanced-search" className="qb" onSubmit={submit} aria-labelledby="qb-title">
      <div className="qb__head">
        <div>
          <h2 id="qb-title" className="qb__title">Find replays where…</h2>
          <p className="qb__hint">
            Add a line for each rule. AND is applied before OR, so <em>a</em> AND <em>b</em> OR <em>c</em> means (
            <em>a</em> AND <em>b</em>) OR <em>c</em>. Player names use the Filters&rsquo; account type (registered only
            unless you include guests); spaces in names count.
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close advanced search">
          ✕
        </button>
      </div>

      <ol className="qb__rules">
        {draft.map((rule, i) => (
          <RuleLine
            key={rule.id}
            rule={rule}
            index={i}
            fieldRef={(el) => (fieldRefs.current[i] = el)}
            onChange={(patch, replace) => (replace ? setDraft((d) => d.map((r, j) => (j === i ? patch : r))) : update(i, patch))}
            onRemove={() => remove(i)}
          />
        ))}
      </ol>

      <div className="qb__bar">
        {draft.length < MAX_RULES && (
          <button type="button" className="qb__add" onClick={add}>
            + Add rule
          </button>
        )}
        <button type="button" className="qb__clear" onClick={() => onSearch([])}>
          ↺ Clear
        </button>
        <span className="qb__spacer" />
        <button type="submit" className="btn btn--primary">
          Search
        </button>
      </div>

      <div className="qb__examples">
        <span>Try:</span>
        {EXAMPLES.map(([label, rs]) => (
          <button
            key={label}
            type="button"
            className="qb__example"
            onClick={() => onSearch(rs.map((r, i) => withDefaults({ conn: "and", ...r, id: i })).map(({ id, ...r }) => r))}
          >
            {label}
          </button>
        ))}
      </div>
    </form>
  );
}

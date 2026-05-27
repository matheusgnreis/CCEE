import { useEffect, useRef, useState } from "react";

export default function MultiSelect({ options, value, onChange, placeholder, width }) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    function onOut(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, []);

  const filtered     = options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()));
  const allSelected  = value.length > 0 && value.length === options.length;
  const someSelected = value.length > 0 && !allSelected;

  function toggle(v) {
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v]);
  }
  function toggleAll() {
    onChange(allSelected ? [] : options.map(o => o.value));
  }
  function clear(e) { e.stopPropagation(); onChange([]); setSearch(""); }

  const label = value.length === 0 ? placeholder
    : value.length === 1 ? (options.find(o => o.value === value[0])?.label ?? value[0])
    : `${value.length} selecionados`;

  return (
    <div ref={ref} style={{ position: "relative", minWidth: width ?? 180 }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", fontSize: 13, border: "1.5px solid #e2e8f0",
          borderRadius: 8, background: "#fff", color: value.length ? "#1e293b" : "#94a3b8",
          cursor: "pointer", userSelect: "none",
          ...(open ? { borderColor: "#2563eb", boxShadow: "0 0 0 3px rgba(37,99,235,0.1)" } : {}),
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 6 }}>
          {value.length > 0 && (
            <span
              onMouseDown={clear}
              style={{ fontSize: 16, color: "#94a3b8", lineHeight: 1, cursor: "pointer", padding: "0 2px" }}
            >×</span>
          )}
          <span style={{ fontSize: 10, color: "#94a3b8" }}>{open ? "▲" : "▼"}</span>
        </span>
      </div>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)", overflow: "hidden",
          minWidth: Math.max(width ?? 180, 220),
        }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9" }}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              onClick={e => e.stopPropagation()}
              placeholder="Buscar..."
              style={{
                width: "100%", padding: "6px 10px", fontSize: 13, border: "1px solid #e2e8f0",
                borderRadius: 6, outline: "none", color: "#1e293b", background: "#f8fafc",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            <label style={st.item}>
              <input
                type="checkbox" checked={allSelected}
                ref={el => { if (el) el.indeterminate = someSelected; }}
                onChange={toggleAll}
                style={st.check}
              />
              <span style={{ color: "#64748b", fontSize: 12, fontStyle: "italic" }}>
                {allSelected ? "Desmarcar todos" : "Selecionar todos"}
              </span>
            </label>
            <div style={{ borderBottom: "1px solid #f1f5f9" }} />
            {filtered.length === 0 && (
              <p style={{ margin: 0, padding: "10px 14px", fontSize: 12, color: "#94a3b8" }}>
                Nenhum resultado
              </p>
            )}
            {filtered.map(o => (
              <label key={o.value} style={st.item}>
                <input
                  type="checkbox" checked={value.includes(o.value)}
                  onChange={() => toggle(o.value)}
                  style={st.check}
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const st = {
  item: {
    display: "flex", alignItems: "center", gap: 8, padding: "8px 14px",
    fontSize: 13, color: "#1e293b", cursor: "pointer",
  },
  check: { accentColor: "#2563eb", width: 15, height: 15, cursor: "pointer", flexShrink: 0 },
};

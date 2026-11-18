const RISK_COLORS = {
  low: "#176b45",
  moderate: "#c48a1a",
  high: "#c45c12",
  extreme: "#9f2d2d",
  unknown: "#5a6b7a",
};

const STATUS_COLORS = {
  open: "#1d515a",
  acknowledged: "#0f6e6b",
  blocked: "#9f2d2d",
  urgent: "#9f2d2d",
  high: "#c45c12",
  routine: "#5d6d6a",
  measured: "#176b45",
  estimated: "#c48a1a",
  insufficient: "#5a6b7a",
};

function totalOf(items) {
  return items.reduce((sum, item) => sum + item.value, 0);
}

export function DonutChart({ title, items, size = 168, thickness = 22, centerLabel, centerValue }) {
  const data = items.filter((item) => item.value > 0);
  const total = totalOf(items) || 1;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="chart-block">
      {title && <h2>{title}</h2>}
      <div className="donut-wrap">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ maxWidth: "100%", height: "auto" }} role="img" aria-label={title || "Donut chart"}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e7eeeb" strokeWidth={thickness} />
          {data.length === 0 ? null : data.map((item) => {
            const length = (item.value / total) * circumference;
            const node = (
              <circle
                key={item.id}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={item.color}
                strokeWidth={thickness}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              >
                <title>{`${item.label}: ${item.value}`}</title>
              </circle>
            );
            offset += length;
            return node;
          })}
          <text x="50%" y="46%" textAnchor="middle" className="chart-center-value">{centerValue ?? totalOf(items)}</text>
          <text x="50%" y="58%" textAnchor="middle" className="chart-center-label">{centerLabel || "total"}</text>
        </svg>
        <ul className="chart-legend">
          {items.map((item) => (
            <li key={item.id}><i style={{ background: item.color }} /><span>{item.label}</span><b>{item.value}</b></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function BarChart({ title, series, height = 180, colors = ["#0f6e6b", "#c48a1a"] }) {
  const keys = series[0] ? Object.keys(series[0]).filter((key) => key !== "label") : [];
  const max = Math.max(1, ...series.flatMap((point) => keys.map((key) => Number(point[key]) || 0)));
  const width = Math.max(360, series.length * 28);
  const pad = { top: 16, right: 12, bottom: 34, left: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const group = plotW / Math.max(series.length, 1);
  const barW = Math.max(4, (group - 6) / Math.max(keys.length, 1));
  return (
    <div className="chart-block">
      {title && <h2>{title}</h2>}
      <div className="chart-frame">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={title || "Bar chart"}>
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const y = pad.top + plotH - tick * plotH;
            return (
              <g key={tick}>
                <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#e7eeeb" />
                <text x={pad.left - 6} y={y + 3} textAnchor="end" className="chart-axis">{Math.round(max * tick)}</text>
              </g>
            );
          })}
          {series.map((point, index) => {
            const x0 = pad.left + index * group + 3;
            return (
              <g key={point.label}>
                {keys.map((key, keyIndex) => {
                  const value = Number(point[key]) || 0;
                  const h = (value / max) * plotH;
                  const x = x0 + keyIndex * barW;
                  const y = pad.top + plotH - h;
                  return (
                    <rect key={key} x={x} y={y} width={Math.max(barW - 1.5, 2)} height={Math.max(h, value ? 2 : 0)} rx="3" fill={colors[keyIndex % colors.length]}>
                      <title>{`${point.label} ${key}: ${value}`}</title>
                    </rect>
                  );
                })}
                <text x={x0 + (group - 6) / 2} y={height - 12} textAnchor="middle" className="chart-axis">{point.label}</text>
              </g>
            );
          })}
        </svg>
      </div>
      {keys.length > 1 && (
        <ul className="chart-legend row-legend">
          {keys.map((key, index) => (
            <li key={key}><i style={{ background: colors[index % colors.length] }} /><span>{key}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HorizontalBars({ title, items, valueLabel = "count" }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div className="chart-block">
      {title && <h2>{title}</h2>}
      {items.length === 0 && <p className="muted">Nothing to chart yet.</p>}
      <div className="hbar-list">
        {items.map((item) => (
          <div key={item.id} className="hbar-row">
            <div className="hbar-label">
              <strong>{item.label}</strong>
              <span>{item.value} {valueLabel}{item.meta ? ` · ${item.meta}` : ""}</span>
            </div>
            <div className="hbar-track">
              <i style={{ width: `${(item.value / max) * 100}%`, background: item.color || "#0f6e6b" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LineChart({ title, series, height = 180, colors = ["#0f6e6b", "#c45c12"] }) {
  const keys = series[0] ? Object.keys(series[0]).filter((key) => key !== "label") : [];
  const max = Math.max(1, ...series.flatMap((point) => keys.map((key) => Number(point[key]) || 0)));
  const width = Math.max(360, series.length * 24);
  const pad = { top: 16, right: 12, bottom: 34, left: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const step = series.length > 1 ? plotW / (series.length - 1) : plotW;
  const pointsFor = (key) => series.map((point, index) => {
    const x = pad.left + index * step;
    const y = pad.top + plotH - ((Number(point[key]) || 0) / max) * plotH;
    return `${x},${y}`;
  }).join(" ");
  return (
    <div className="chart-block">
      {title && <h2>{title}</h2>}
      <div className="chart-frame">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={title || "Line chart"}>
          {[0, 0.5, 1].map((tick) => {
            const y = pad.top + plotH - tick * plotH;
            return (
              <g key={tick}>
                <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#e7eeeb" />
                <text x={pad.left - 6} y={y + 3} textAnchor="end" className="chart-axis">{Math.round(max * tick)}</text>
              </g>
            );
          })}
          {keys.map((key, index) => (
            <polyline key={key} fill="none" stroke={colors[index % colors.length]} strokeWidth="2.5" points={pointsFor(key)} />
          ))}
          {series.map((point, index) => (
            <text key={point.label} x={pad.left + index * step} y={height - 12} textAnchor="middle" className="chart-axis">{point.label}</text>
          ))}
        </svg>
      </div>
      <ul className="chart-legend row-legend">
        {keys.map((key, index) => (
          <li key={key}><i style={{ background: colors[index % colors.length] }} /><span>{key}</span></li>
        ))}
      </ul>
    </div>
  );
}

export function Meter({ label, value, max = 100, color = "#0f6e6b", suffix = "%" }) {
  const safe = value == null ? null : Math.max(0, Math.min(max, value));
  return (
    <div className="meter">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">{label}</span>
        <strong>{safe == null ? "—" : `${safe}${suffix}`}</strong>
      </div>
      <div className="meter-track"><i style={{ width: `${safe == null ? 0 : (safe / max) * 100}%`, background: color }} /></div>
    </div>
  );
}

export function riskItems(mix) {
  return ["low", "moderate", "high", "extreme", "unknown"].map((id) => ({
    id,
    label: id === "unknown" ? "Unknown" : id[0].toUpperCase() + id.slice(1),
    value: Number(mix?.[id] ?? 0),
    color: RISK_COLORS[id],
  }));
}

export function statusItems(counts) {
  return [
    { id: "open", label: "Open", value: Number(counts?.open ?? 0), color: STATUS_COLORS.open },
    { id: "acknowledged", label: "Acknowledged", value: Number(counts?.acknowledged ?? 0), color: STATUS_COLORS.acknowledged },
    { id: "blocked", label: "Blocked", value: Number(counts?.blocked ?? 0), color: STATUS_COLORS.blocked },
  ];
}

export function priorityItems(counts) {
  return [
    { id: "urgent", label: "Urgent", value: Number(counts?.urgent ?? 0), color: STATUS_COLORS.urgent },
    { id: "high", label: "High", value: Number(counts?.high ?? 0), color: STATUS_COLORS.high },
    { id: "routine", label: "Routine", value: Number(counts?.routine ?? 0), color: STATUS_COLORS.routine },
  ];
}

export function basisItems(mix) {
  return [
    { id: "measured", label: "Measured WBGT", value: Number(mix?.measured ?? 0), color: STATUS_COLORS.measured },
    { id: "estimated", label: "Estimated", value: Number(mix?.estimated ?? 0), color: STATUS_COLORS.estimated },
    { id: "insufficient", label: "Insufficient data", value: Number(mix?.insufficient ?? 0), color: STATUS_COLORS.insufficient },
  ];
}

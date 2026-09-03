export function mapAiResultToDashboard(results) {
  const list = Array.isArray(results) ? results : [results];

  const kpis = list.flatMap((r, fi) =>
    (r.suggestedKpis || []).map((k, i) => {
      const numeric = Number(k.value);
      const isNumeric = k.value !== "" && k.value != null && !Number.isNaN(numeric);
      return {
        id: `ai-${fi}-${i}`,
        label: k.label,
        value: isNumeric ? numeric : 0,
        displayValue: isNumeric ? undefined : k.value,
        suffix: "",
        delta: 0,
        direction: "up",
        icon: "sparkles",
        spark: [1, 1, 1, 1, 1, 1, 1],
      };
    })
  );

  const charts = list.flatMap((r) => r.charts || []);

  const activity = list.flatMap((r, fi) =>
    (r.insights || []).map((text, i) => ({
      id: `${fi}-${i}`,
      text,
      time: "Just now",
      tone: fi === 0 && i === 0 ? "highlight" : "default",
    }))
  );

  return {
    kpis,
    charts,
    activity,
    table: [],
    summaries: list.map((r) => r.summary).filter(Boolean),
  };
}

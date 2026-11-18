import { CLOTHING_LABEL, INTENSITY_LABEL, LEVEL_LABEL, levelRank } from "./protocol.js";

export function heatIndexC(tempC, rh) {
  const tempF = (tempC * 9) / 5 + 32;
  const simple = 0.5 * (tempF + 61 + (tempF - 68) * 1.2 + rh * 0.094);
  let hi;
  if ((simple + tempF) / 2 < 80) {
    hi = simple;
  } else {
    hi =
      -42.379 +
      2.04901523 * tempF +
      10.14333127 * rh -
      0.22475541 * tempF * rh -
      0.00683783 * tempF * tempF -
      0.05481717 * rh * rh +
      0.00122874 * tempF * tempF * rh +
      0.00085282 * tempF * rh * rh -
      0.00000199 * tempF * tempF * rh * rh;
    if (rh < 13 && tempF >= 80 && tempF <= 112) {
      hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tempF - 95)) / 17);
    } else if (rh > 85 && tempF >= 80 && tempF <= 87) {
      hi += ((rh - 85) / 10) * ((87 - tempF) / 5);
    }
  }
  return Math.round((((hi - 32) * 5) / 9) * 10) / 10;
}

export function sourceLabel(source) {
  return {
    forecast: "Forecast",
    current: "Current conditions (remote)",
    onsite_wbgt: "On-site WBGT instrument",
    manual: "Manual on-site entry",
  }[source];
}

function minutesAgo(at, now) {
  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
}

export function validateReading(reading, cfg, now) {
  const issues = [];
  const freshness = cfg.freshnessMinutes[reading.source];
  const age = minutesAgo(reading.observedAt, now);
  if (reading.observedAt.getTime() - now.getTime() > 3 * 60 * 60 * 1000 && reading.source !== "forecast") {
    issues.push("Timestamp is in the future");
  }
  if (reading.source === "forecast") {
    if (Math.abs(reading.observedAt.getTime() - now.getTime()) > freshness * 60000) {
      issues.push(`Forecast is not for the current period (window ±${freshness} min)`);
    }
  } else if (age > freshness) {
    issues.push(`Reading is ${age} min old (limit ${freshness} min)`);
  }
  if (reading.source === "onsite_wbgt" || (reading.source === "manual" && reading.wbgtC != null)) {
    if (reading.wbgtC == null || reading.wbgtC < -10 || reading.wbgtC > 50) {
      issues.push("WBGT value missing or out of range");
    }
  } else {
    if (reading.airTempC == null || reading.airTempC < -40 || reading.airTempC > 65) {
      issues.push("Air temperature missing or out of range");
    }
    if (reading.relativeHumidity == null || reading.relativeHumidity < 0 || reading.relativeHumidity > 100) {
      issues.push("Humidity missing or out of range");
    }
  }
  return issues;
}

export function assess({ cfg, protocolVersion, site, crew, readings, now }) {
  const dataIssues = [];
  const reasons = [];
  const controls = new Set();
  const sorted = [...readings].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const measured = sorted.filter(
    (reading) => reading.wbgtC != null && (reading.source === "onsite_wbgt" || reading.source === "manual"),
  );
  const estimated = sorted.filter(
    (reading) =>
      reading.wbgtC == null &&
      (reading.source === "current" || reading.source === "forecast" || reading.source === "manual"),
  );
  let chosen = null;
  let metric = "none";
  for (const reading of measured) {
    const issues = validateReading(reading, cfg, now);
    if (!issues.length) {
      chosen = reading;
      metric = "wbgt_measured";
      break;
    }
    dataIssues.push(`${sourceLabel(reading.source)}: ${issues.join("; ")}`);
    break;
  }
  if (!chosen) {
    const ordered = [
      ...estimated.filter((reading) => reading.source !== "forecast"),
      ...estimated.filter((reading) => reading.source === "forecast"),
    ];
    const seen = new Set();
    for (const reading of ordered) {
      const issues = validateReading(reading, cfg, now);
      if (!issues.length) {
        chosen = reading;
        metric = "heat_index_estimated";
        break;
      }
      if (!seen.has(reading.source)) {
        dataIssues.push(`${sourceLabel(reading.source)}: ${issues.join("; ")}`);
        seen.add(reading.source);
      }
    }
  }
  if (!chosen) {
    if (!readings.length) dataIssues.push("No environmental data recorded for this site");
    reasons.push("No valid, current environmental data — risk cannot be assessed automatically.");
    reasons.push("Treat conditions as unassessed: take an on-site measurement and apply the site's manual procedure.");
    cfg.levels.unknown.forEach((id) => controls.add(id));
    return {
      riskLevel: "unknown",
      basis: "insufficient",
      metric: "none",
      metricValue: null,
      adjustedValue: null,
      readingId: null,
      dataIssues,
      reasons,
      controls: [...controls],
      requiresHumanReview: true,
    };
  }
  const raw =
    metric === "wbgt_measured"
      ? chosen.wbgtC
      : (chosen.heatIndexC ?? heatIndexC(chosen.airTempC, chosen.relativeHumidity));
  const clothingAdj = cfg.clothingAdjustmentC[crew.clothing] ?? 0;
  const adjusted = Math.round((raw + clothingAdj) * 10) / 10;
  const unacclimatized = crew.acclimatization !== "acclimatized";
  const table = metric === "wbgt_measured" ? cfg.thresholds.wbgt : cfg.thresholds.heatIndex;
  const bands = unacclimatized ? table.unacclimatized[crew.taskIntensity] : table.acclimatized[crew.taskIntensity];
  let riskLevel = "low";
  for (const level of ["moderate", "high", "extreme"]) {
    if (adjusted >= bands[level]) riskLevel = level;
  }
  const age = minutesAgo(chosen.observedAt, now);
  if (metric === "wbgt_measured") {
    reasons.push(`${sourceLabel(chosen.source)}: WBGT ${raw.toFixed(1)} °C, ${age} min ago.`);
  } else {
    reasons.push(
      `${sourceLabel(chosen.source)}${chosen.provider ? ` (${chosen.provider})` : ""}: ${chosen.airTempC?.toFixed(1)} °C, ${chosen.relativeHumidity?.toFixed(0)}% RH → heat index ${raw.toFixed(1)} °C (shade estimate${chosen.source === "forecast" ? ", forecast" : `, ${age} min ago`}).`,
    );
    reasons.push(
      "This is an estimate from remote data, not a measurement of exposure at the work area. Full sun, radiant heat and work rate can make conditions worse.",
    );
  }
  reasons.push(
    `${crew.name}: ${INTENSITY_LABEL[crew.taskIntensity]} work in ${CLOTHING_LABEL[crew.clothing]}${clothingAdj ? ` (+${clothingAdj} °C clothing adjustment)` : ""}.`,
  );
  if (unacclimatized) {
    reasons.push(
      `Crew ${crew.acclimatization === "new_workers" ? "includes new or returning workers" : "is partly acclimatized"} → more protective thresholds used.`,
    );
  }
  const next = ["moderate", "high", "extreme"].find((level) => adjusted < bands[level]);
  reasons.push(
    `Adjusted value ${adjusted.toFixed(1)} °C ⇒ ${LEVEL_LABEL[riskLevel]}` +
      (next ? ` (${LEVEL_LABEL[next]} starts at ${bands[next].toFixed(1)} °C).` : ".") +
      ` Protocol v${protocolVersion}.`,
  );
  cfg.levels[riskLevel].forEach((id) => controls.add(id));
  const rank = levelRank(riskLevel);
  if (metric === "heat_index_estimated" && rank >= levelRank(cfg.requireOnsiteMeasurementAtOrAbove)) {
    controls.add("onsite_measurement");
    reasons.push(
      "Estimated risk is at or above the protocol's on-site measurement trigger: confirm with a WBGT instrument.",
    );
  }
  if (rank >= levelRank("moderate")) {
    if (!site.facilities.drinkingWater) {
      controls.add("provide_water");
      reasons.push("Site record shows no drinking water at the work area.");
    }
    if (!site.facilities.shade) {
      controls.add("provide_shade");
      reasons.push("Site record shows no shade for rest breaks.");
    }
    if (!site.facilities.coolRestArea && rank >= levelRank("high")) controls.add("cool_rest_area");
    if (crew.acclimatization === "new_workers") controls.add("acclimatization_plan");
  }
  const requiresHumanReview = rank >= levelRank(cfg.humanReviewAtOrAbove);
  if (requiresHumanReview) controls.add("stop_work_review");
  return {
    riskLevel,
    basis: metric === "wbgt_measured" ? "measured" : "estimated",
    metric,
    metricValue: Math.round(raw * 10) / 10,
    adjustedValue: adjusted,
    readingId: chosen.id,
    dataIssues,
    reasons,
    controls: [...controls],
    requiresHumanReview,
  };
}

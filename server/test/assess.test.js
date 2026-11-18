import assert from "node:assert/strict";
import test from "node:test";
import { assess, heatIndexC } from "../src/assess.js";
import { DEFAULT_PROTOCOL, validateProtocol } from "../src/protocol.js";
import { passwordProblem } from "../src/crypto.js";

const now = new Date("2026-07-15T08:00:00Z");

function reading(overrides) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "current",
    observedAt: new Date("2026-07-15T07:40:00Z"),
    airTempC: 34,
    relativeHumidity: 45,
    wbgtC: null,
    provider: "Open-Meteo",
    ...overrides,
  };
}

const site = { name: "North Yard", facilities: { drinkingWater: true, shade: true, coolRestArea: false } };
const crew = { name: "Crew A", taskIntensity: "heavy", clothing: "standard", acclimatization: "acclimatized" };

test("heat index uses the simple formula below 80 °F", () => {
  assert.equal(heatIndexC(20, 50), 19.4);
});

test("heat index uses the Rothfusz regression in hot humid air", () => {
  const value = heatIndexC(35, 60);
  assert.ok(value > 40 && value < 55, `expected a high heat index, got ${value}`);
});

test("a fresh WBGT reading is preferred over a heat-index estimate", () => {
  const result = assess({
    cfg: DEFAULT_PROTOCOL,
    protocolVersion: 1,
    site,
    crew,
    now,
    readings: [
      reading({}),
      reading({
        id: "22222222-2222-4222-8222-222222222222",
        source: "onsite_wbgt",
        wbgtC: 30.2,
        airTempC: null,
        relativeHumidity: null,
        provider: "On-site instrument",
      }),
    ],
  });
  assert.equal(result.basis, "measured");
  assert.equal(result.riskLevel, "extreme");
  assert.equal(result.requiresHumanReview, true);
  assert.ok(result.controls.includes("stop_work_review"));
});

test("missing facilities and new workers add protective controls", () => {
  const result = assess({
    cfg: DEFAULT_PROTOCOL,
    protocolVersion: 1,
    site: { ...site, facilities: { drinkingWater: false, shade: false, coolRestArea: false } },
    crew: { ...crew, acclimatization: "new_workers", clothing: "vapour_barrier" },
    now,
    readings: [reading({ airTempC: 36, relativeHumidity: 40 })],
  });
  assert.equal(result.basis, "estimated");
  assert.ok(result.controls.includes("provide_water"));
  assert.ok(result.controls.includes("provide_shade"));
  assert.ok(result.controls.includes("acclimatization_plan"));
  assert.ok(result.controls.includes("onsite_measurement"));
  assert.ok(result.adjustedValue > result.metricValue);
});

test("no usable data returns an unknown risk and a manual procedure", () => {
  const result = assess({
    cfg: DEFAULT_PROTOCOL,
    protocolVersion: 1,
    site,
    crew,
    now,
    readings: [reading({ observedAt: new Date("2026-07-14T00:00:00Z") })],
  });
  assert.equal(result.riskLevel, "unknown");
  assert.equal(result.basis, "insufficient");
  assert.deepEqual(result.controls.sort(), ["manual_assessment", "onsite_measurement"].sort());
});

test("the example protocol satisfies the system control rules", () => {
  const parsed = validateProtocol(DEFAULT_PROTOCOL);
  assert.equal(parsed.ok, true);
});

test("a protocol cannot assign stop-work review away from a safety lead", () => {
  const broken = structuredClone(DEFAULT_PROTOCOL);
  broken.controls.find((control) => control.id === "stop_work_review").assignedRole = "supervisor";
  const parsed = validateProtocol(broken);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /Safety Lead/);
});

test("passwords need length and mixed character classes", () => {
  assert.match(passwordProblem("short"), /12/);
  assert.match(passwordProblem("alllowercase!!"), /three/);
  assert.equal(passwordProblem("Harbour-Yard-24"), null);
});

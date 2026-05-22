export type DtcSeverity = "minor" | "moderate" | "severe";
export type DtcCategory = "powertrain" | "chassis" | "body" | "network";

export interface DtcInfo {
  code: string;
  name: string;
  description: string;
  category: DtcCategory;
  severity: DtcSeverity;
  likely_causes: string[];
  repair_difficulty: number;
}

const DTC_CODES: Record<string, Omit<DtcInfo, "code">> = {
  "P0100": { name: "MAF Sensor Circuit Malfunction", description: "The mass airflow sensor is reporting values outside the expected range.", category: "powertrain", severity: "moderate", likely_causes: ["Dirty MAF sensor", "Loose air intake", "Faulty MAF sensor", "Wiring issue"], repair_difficulty: 2 },
  "P0101": { name: "MAF Sensor Performance", description: "MAF sensor reading does not match what the engine is doing.", category: "powertrain", severity: "moderate", likely_causes: ["Dirty MAF sensor", "Air leak", "Vacuum leak"], repair_difficulty: 2 },
  "P0128": { name: "Coolant Below Thermostat Regulating Temp", description: "Engine not reaching operating temperature in expected time.", category: "powertrain", severity: "minor", likely_causes: ["Stuck-open thermostat", "Faulty ECT sensor", "Low coolant"], repair_difficulty: 2 },
  "P0171": { name: "System Too Lean (Bank 1)", description: "Engine is running with insufficient fuel relative to air.", category: "powertrain", severity: "moderate", likely_causes: ["Vacuum leak", "Dirty MAF", "Weak fuel pump", "Clogged fuel filter", "Faulty O2 sensor"], repair_difficulty: 3 },
  "P0172": { name: "System Too Rich (Bank 1)", description: "Engine is running with too much fuel relative to air.", category: "powertrain", severity: "moderate", likely_causes: ["Leaking injector", "Faulty MAF", "Excessive fuel pressure"], repair_difficulty: 3 },
  "P0300": { name: "Random/Multiple Cylinder Misfire", description: "Engine is misfiring across multiple cylinders.", category: "powertrain", severity: "severe", likely_causes: ["Worn spark plugs", "Faulty ignition coils", "Fuel delivery problem", "Vacuum leak", "Low fuel pressure"], repair_difficulty: 3 },
  "P0301": { name: "Cylinder 1 Misfire", description: "Cylinder 1 is misfiring.", category: "powertrain", severity: "severe", likely_causes: ["Faulty spark plug", "Bad ignition coil", "Faulty fuel injector", "Low compression"], repair_difficulty: 3 },
  "P0302": { name: "Cylinder 2 Misfire", description: "Cylinder 2 is misfiring.", category: "powertrain", severity: "severe", likely_causes: ["Faulty spark plug", "Bad ignition coil", "Faulty fuel injector"], repair_difficulty: 3 },
  "P0303": { name: "Cylinder 3 Misfire", description: "Cylinder 3 is misfiring.", category: "powertrain", severity: "severe", likely_causes: ["Faulty spark plug", "Bad ignition coil"], repair_difficulty: 3 },
  "P0304": { name: "Cylinder 4 Misfire", description: "Cylinder 4 is misfiring.", category: "powertrain", severity: "severe", likely_causes: ["Faulty spark plug", "Bad ignition coil"], repair_difficulty: 3 },
  "P0420": { name: "Catalyst Efficiency Below Threshold (Bank 1)", description: "The catalytic converter is not performing as efficiently as expected.", category: "powertrain", severity: "moderate", likely_causes: ["Aged catalytic converter", "Faulty O2 sensor", "Exhaust leak before cat"], repair_difficulty: 4 },
  "P0430": { name: "Catalyst Efficiency Below Threshold (Bank 2)", description: "Bank 2 catalytic converter inefficient.", category: "powertrain", severity: "moderate", likely_causes: ["Aged catalyst", "Faulty O2 sensor"], repair_difficulty: 4 },
  "P0440": { name: "EVAP System Malfunction", description: "Evaporative emission control system problem.", category: "powertrain", severity: "minor", likely_causes: ["Loose gas cap", "Faulty purge valve", "Cracked EVAP hose"], repair_difficulty: 2 },
  "P0455": { name: "EVAP Large Leak Detected", description: "Large leak in the evaporative emissions system.", category: "powertrain", severity: "moderate", likely_causes: ["Missing gas cap", "Major hose leak", "Damaged EVAP canister"], repair_difficulty: 2 },
  "P0505": { name: "Idle Air Control Malfunction", description: "Idle air control system problem.", category: "powertrain", severity: "moderate", likely_causes: ["Dirty throttle body", "Faulty IAC valve", "Vacuum leak"], repair_difficulty: 3 },
  "P0562": { name: "System Voltage Low", description: "Battery / charging voltage below threshold.", category: "powertrain", severity: "moderate", likely_causes: ["Weak battery", "Failing alternator", "Loose battery cable"], repair_difficulty: 2 },
  "P0563": { name: "System Voltage High", description: "Battery / charging voltage above threshold.", category: "powertrain", severity: "moderate", likely_causes: ["Faulty voltage regulator", "Overcharging alternator"], repair_difficulty: 3 },
  "P0700": { name: "Transmission Control System Malfunction", description: "Generic transmission control fault.", category: "powertrain", severity: "severe", likely_causes: ["Internal transmission fault", "TCM issue", "Solenoid failure"], repair_difficulty: 5 },
  "P0A80": { name: "Replace Hybrid Battery Pack", description: "Hybrid battery pack has degraded enough that replacement is recommended.", category: "powertrain", severity: "severe", likely_causes: ["Aged hybrid battery cells", "Cell imbalance"], repair_difficulty: 5 },
};

export function lookupDtc(code: string): DtcInfo | null {
  const normalized = code.trim().toUpperCase();
  const info = DTC_CODES[normalized];
  if (!info) {
    const category: DtcCategory = normalized.startsWith("B") ? "body"
      : normalized.startsWith("C") ? "chassis"
      : normalized.startsWith("U") ? "network"
      : "powertrain";
    return {
      code: normalized,
      name: `Unknown ${category} code`,
      description: "This code is not in the curated database.",
      category,
      severity: "moderate",
      likely_causes: [],
      repair_difficulty: 3,
    };
  }
  return { code: normalized, ...info };
}

export function lookupDtcs(codes: string[]): DtcInfo[] {
  return codes.map(lookupDtc).filter((d): d is DtcInfo => d !== null);
}

export function searchDtcs(query: string): DtcInfo[] {
  const q = query.toLowerCase();
  return Object.entries(DTC_CODES)
    .map(([code, info]) => ({ code, ...info }))
    .filter(
      (d) =>
        d.code.toLowerCase().includes(q) ||
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q),
    );
}

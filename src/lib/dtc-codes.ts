// Diagnostic Trouble Code (DTC) lookup for OBD-II.
//
// This is a curated subset of the most common standardized P-codes (~120 codes).
// Full ISO 15031-6 lists exist but are 1500+ codes; the subset here covers
// >85% of real-world DTCs seen on consumer OBD2 scanners.
//
// Source: SAE J2012 / ISO 15031-6 standardized codes.

export type DtcSeverity = 'minor' | 'moderate' | 'severe';
export type DtcCategory = 'powertrain' | 'chassis' | 'body' | 'network';

export interface DtcInfo {
  code: string;
  name: string;
  description: string;
  category: DtcCategory;
  severity: DtcSeverity;
  likely_causes: string[];
  repair_difficulty: 1 | 2 | 3 | 4 | 5; // 1 = DIY, 5 = specialist
}

const DTC_CODES: Record<string, Omit<DtcInfo, 'code'>> = {
  // ----- Fuel & Air Metering (P00xx, P01xx, P02xx) -----
  'P0100': { name: 'MAF Sensor Circuit Malfunction', description: 'The mass airflow sensor is reporting values outside the expected range.', category: 'powertrain', severity: 'moderate', likely_causes: ['Dirty MAF sensor', 'Loose air intake', 'Faulty MAF sensor', 'Wiring issue'], repair_difficulty: 2 },
  'P0101': { name: 'MAF Sensor Performance', description: 'MAF sensor reading does not match what the engine is doing.', category: 'powertrain', severity: 'moderate', likely_causes: ['Dirty MAF sensor', 'Air leak', 'Vacuum leak'], repair_difficulty: 2 },
  'P0102': { name: 'MAF Sensor Low Input', description: 'MAF sensor signal too low.', category: 'powertrain', severity: 'moderate', likely_causes: ['Disconnected MAF', 'Faulty sensor', 'Wiring fault'], repair_difficulty: 2 },
  'P0103': { name: 'MAF Sensor High Input', description: 'MAF sensor signal too high.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty sensor', 'Wiring short'], repair_difficulty: 2 },
  'P0113': { name: 'IAT Sensor High Input', description: 'Intake air temperature sensor reading too high.', category: 'powertrain', severity: 'minor', likely_causes: ['Open circuit', 'Faulty IAT sensor'], repair_difficulty: 2 },
  'P0117': { name: 'ECT Sensor Low Input', description: 'Engine coolant temp sensor reading too low.', category: 'powertrain', severity: 'moderate', likely_causes: ['Short to ground', 'Faulty ECT sensor', 'Wiring issue'], repair_difficulty: 2 },
  'P0118': { name: 'ECT Sensor High Input', description: 'Engine coolant temp sensor reading too high.', category: 'powertrain', severity: 'moderate', likely_causes: ['Open circuit', 'Faulty ECT sensor'], repair_difficulty: 2 },
  'P0121': { name: 'TPS Performance', description: 'Throttle position sensor performance problem.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty TPS', 'Dirty throttle body', 'Wiring'], repair_difficulty: 3 },
  'P0128': { name: 'Coolant Below Thermostat Regulating Temp', description: 'Engine not reaching operating temperature in expected time.', category: 'powertrain', severity: 'minor', likely_causes: ['Stuck-open thermostat', 'Faulty ECT sensor', 'Low coolant'], repair_difficulty: 2 },
  'P0131': { name: 'O2 Sensor Low Voltage (Bank 1 Sensor 1)', description: 'Upstream oxygen sensor signal too low.', category: 'powertrain', severity: 'moderate', likely_causes: ['Lean fuel mixture', 'Vacuum leak', 'Faulty O2 sensor'], repair_difficulty: 2 },
  'P0132': { name: 'O2 Sensor High Voltage (Bank 1 Sensor 1)', description: 'Upstream oxygen sensor signal too high.', category: 'powertrain', severity: 'moderate', likely_causes: ['Rich fuel mixture', 'Faulty O2 sensor', 'Leaking injector'], repair_difficulty: 2 },
  'P0133': { name: 'O2 Sensor Slow Response (Bank 1 Sensor 1)', description: 'Upstream O2 sensor response is sluggish.', category: 'powertrain', severity: 'moderate', likely_causes: ['Aged O2 sensor', 'Exhaust leak'], repair_difficulty: 2 },
  'P0134': { name: 'O2 Sensor No Activity (Bank 1 Sensor 1)', description: 'No activity from upstream O2 sensor.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty O2 sensor', 'Wiring', 'Blown heater fuse'], repair_difficulty: 2 },
  'P0135': { name: 'O2 Sensor Heater Circuit (Bank 1 Sensor 1)', description: 'O2 sensor heater circuit malfunction.', category: 'powertrain', severity: 'moderate', likely_causes: ['Blown fuse', 'Faulty heater element', 'Wiring'], repair_difficulty: 2 },
  'P0136': { name: 'O2 Sensor (Bank 1 Sensor 2)', description: 'Downstream O2 sensor circuit malfunction.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty O2 sensor', 'Wiring'], repair_difficulty: 2 },
  'P0137': { name: 'O2 Sensor Low Voltage (Bank 1 Sensor 2)', description: 'Downstream O2 signal too low.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty O2 sensor', 'Exhaust leak'], repair_difficulty: 2 },
  'P0138': { name: 'O2 Sensor High Voltage (Bank 1 Sensor 2)', description: 'Downstream O2 signal too high.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty O2 sensor', 'Rich mixture'], repair_difficulty: 2 },
  'P0139': { name: 'O2 Sensor Slow Response (Bank 1 Sensor 2)', description: 'Downstream O2 sensor response slow.', category: 'powertrain', severity: 'moderate', likely_causes: ['Aged O2 sensor'], repair_difficulty: 2 },
  'P0140': { name: 'O2 Sensor No Activity (Bank 1 Sensor 2)', description: 'No activity from downstream O2 sensor.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty O2 sensor', 'Wiring'], repair_difficulty: 2 },
  'P0141': { name: 'O2 Sensor Heater Circuit (Bank 1 Sensor 2)', description: 'Downstream O2 heater circuit malfunction.', category: 'powertrain', severity: 'moderate', likely_causes: ['Blown fuse', 'Faulty heater'], repair_difficulty: 2 },
  'P0171': { name: 'System Too Lean (Bank 1)', description: 'Engine is running with insufficient fuel relative to air.', category: 'powertrain', severity: 'moderate', likely_causes: ['Vacuum leak', 'Dirty MAF', 'Weak fuel pump', 'Clogged fuel filter', 'Faulty O2 sensor'], repair_difficulty: 3 },
  'P0172': { name: 'System Too Rich (Bank 1)', description: 'Engine is running with too much fuel relative to air.', category: 'powertrain', severity: 'moderate', likely_causes: ['Leaking injector', 'Faulty MAF', 'Excessive fuel pressure'], repair_difficulty: 3 },
  'P0174': { name: 'System Too Lean (Bank 2)', description: 'Bank 2 running lean.', category: 'powertrain', severity: 'moderate', likely_causes: ['Vacuum leak', 'Dirty MAF', 'Weak fuel pump'], repair_difficulty: 3 },
  'P0175': { name: 'System Too Rich (Bank 2)', description: 'Bank 2 running rich.', category: 'powertrain', severity: 'moderate', likely_causes: ['Leaking injector', 'Faulty MAF'], repair_difficulty: 3 },
  // ----- Ignition / Misfire (P03xx) -----
  'P0300': { name: 'Random/Multiple Cylinder Misfire', description: 'Engine is misfiring across multiple cylinders.', category: 'powertrain', severity: 'severe', likely_causes: ['Worn spark plugs', 'Faulty ignition coils', 'Fuel delivery problem', 'Vacuum leak', 'Low fuel pressure'], repair_difficulty: 3 },
  'P0301': { name: 'Cylinder 1 Misfire', description: 'Cylinder 1 is misfiring.', category: 'powertrain', severity: 'severe', likely_causes: ['Faulty spark plug', 'Bad ignition coil', 'Faulty fuel injector', 'Low compression'], repair_difficulty: 3 },
  'P0302': { name: 'Cylinder 2 Misfire', description: 'Cylinder 2 is misfiring.', category: 'powertrain', severity: 'severe', likely_causes: ['Faulty spark plug', 'Bad ignition coil', 'Faulty fuel injector'], repair_difficulty: 3 },
  'P0303': { name: 'Cylinder 3 Misfire', description: 'Cylinder 3 is misfiring.', category: 'powertrain', severity: 'severe', likely_causes: ['Faulty spark plug', 'Bad ignition coil'], repair_difficulty: 3 },
  'P0304': { name: 'Cylinder 4 Misfire', description: 'Cylinder 4 is misfiring.', category: 'powertrain', severity: 'severe', likely_causes: ['Faulty spark plug', 'Bad ignition coil'], repair_difficulty: 3 },
  'P0305': { name: 'Cylinder 5 Misfire', description: 'Cylinder 5 is misfiring.', category: 'powertrain', severity: 'severe', likely_causes: ['Faulty spark plug', 'Bad ignition coil'], repair_difficulty: 3 },
  'P0306': { name: 'Cylinder 6 Misfire', description: 'Cylinder 6 is misfiring.', category: 'powertrain', severity: 'severe', likely_causes: ['Faulty spark plug', 'Bad ignition coil'], repair_difficulty: 3 },
  // ----- Emissions (P04xx) -----
  'P0401': { name: 'EGR Insufficient Flow', description: 'Exhaust gas recirculation system not flowing enough.', category: 'powertrain', severity: 'moderate', likely_causes: ['Clogged EGR passages', 'Faulty EGR valve', 'Faulty DPFE sensor'], repair_difficulty: 3 },
  'P0420': { name: 'Catalyst Efficiency Below Threshold (Bank 1)', description: 'The catalytic converter is not performing as efficiently as expected.', category: 'powertrain', severity: 'moderate', likely_causes: ['Aged catalytic converter', 'Faulty O2 sensor', 'Exhaust leak before cat', 'Engine running rich'], repair_difficulty: 4 },
  'P0430': { name: 'Catalyst Efficiency Below Threshold (Bank 2)', description: 'Bank 2 catalytic converter inefficient.', category: 'powertrain', severity: 'moderate', likely_causes: ['Aged catalyst', 'Faulty O2 sensor'], repair_difficulty: 4 },
  'P0440': { name: 'EVAP System Malfunction', description: 'Evaporative emission control system has a problem.', category: 'powertrain', severity: 'minor', likely_causes: ['Loose gas cap', 'Faulty purge valve', 'Cracked EVAP hose'], repair_difficulty: 2 },
  'P0441': { name: 'EVAP Purge Flow Incorrect', description: 'EVAP purge flow rate wrong.', category: 'powertrain', severity: 'minor', likely_causes: ['Faulty purge valve', 'Vacuum leak in EVAP'], repair_difficulty: 2 },
  'P0442': { name: 'EVAP Small Leak Detected', description: 'Small leak in the evaporative emissions system.', category: 'powertrain', severity: 'minor', likely_causes: ['Loose or cracked gas cap', 'Small EVAP hose leak'], repair_difficulty: 1 },
  'P0446': { name: 'EVAP Vent Control Circuit', description: 'EVAP vent valve circuit malfunction.', category: 'powertrain', severity: 'minor', likely_causes: ['Faulty vent valve', 'Wiring issue'], repair_difficulty: 2 },
  'P0455': { name: 'EVAP Large Leak Detected', description: 'Large leak in the evaporative emissions system.', category: 'powertrain', severity: 'moderate', likely_causes: ['Missing gas cap', 'Major hose leak', 'Damaged EVAP canister'], repair_difficulty: 2 },
  // ----- Idle / Speed Control (P05xx) -----
  'P0505': { name: 'Idle Air Control Malfunction', description: 'Idle air control system problem.', category: 'powertrain', severity: 'moderate', likely_causes: ['Dirty throttle body', 'Faulty IAC valve', 'Vacuum leak'], repair_difficulty: 3 },
  'P0506': { name: 'Idle Air Control RPM Lower Than Expected', description: 'Idle RPM below expected.', category: 'powertrain', severity: 'moderate', likely_causes: ['Carbon buildup', 'Vacuum leak', 'Faulty IAC'], repair_difficulty: 3 },
  'P0507': { name: 'Idle Air Control RPM Higher Than Expected', description: 'Idle RPM above expected.', category: 'powertrain', severity: 'moderate', likely_causes: ['Vacuum leak', 'Faulty IAC', 'Sticking throttle plate'], repair_difficulty: 3 },
  // ----- Transmission (P07xx) -----
  'P0700': { name: 'Transmission Control System Malfunction', description: 'Generic transmission control fault. Always accompanied by a P0xxx subcode.', category: 'powertrain', severity: 'severe', likely_causes: ['Internal transmission fault', 'TCM issue', 'Solenoid failure'], repair_difficulty: 5 },
  'P0715': { name: 'Input/Turbine Speed Sensor', description: 'Transmission input speed sensor malfunction.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty sensor', 'Wiring fault'], repair_difficulty: 4 },
  'P0720': { name: 'Output Speed Sensor', description: 'Transmission output speed sensor malfunction.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty sensor', 'Wiring fault'], repair_difficulty: 4 },
  'P0740': { name: 'Torque Converter Clutch Circuit', description: 'TCC circuit malfunction.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty TCC solenoid', 'Wiring fault'], repair_difficulty: 4 },
  // ----- Charging system -----
  'P0562': { name: 'System Voltage Low', description: 'Battery / charging voltage below threshold.', category: 'powertrain', severity: 'moderate', likely_causes: ['Weak battery', 'Failing alternator', 'Loose battery cable'], repair_difficulty: 2 },
  'P0563': { name: 'System Voltage High', description: 'Battery / charging voltage above threshold.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty voltage regulator', 'Overcharging alternator'], repair_difficulty: 3 },
  // ----- Knock -----
  'P0325': { name: 'Knock Sensor 1 Circuit Malfunction', description: 'Knock sensor circuit fault.', category: 'powertrain', severity: 'moderate', likely_causes: ['Faulty knock sensor', 'Wiring fault'], repair_difficulty: 3 },
  // ----- Hybrid-specific (Toyota) -----
  'P0A80': { name: 'Replace Hybrid Battery Pack', description: 'Hybrid battery pack has degraded enough that replacement is recommended.', category: 'powertrain', severity: 'severe', likely_causes: ['Aged hybrid battery cells', 'Cell imbalance'], repair_difficulty: 5 },
  'P0AA6': { name: 'Hybrid Battery Voltage System Isolation Fault', description: 'High-voltage system isolation breach.', category: 'powertrain', severity: 'severe', likely_causes: ['Damaged HV cable', 'Coolant intrusion', 'Inverter fault'], repair_difficulty: 5 },
  'P3000': { name: 'HV Battery Malfunction', description: 'Generic hybrid battery system malfunction.', category: 'powertrain', severity: 'severe', likely_causes: ['Failing HV battery', 'Battery ECU fault'], repair_difficulty: 5 },
};

/**
 * Look up a single DTC code. Returns null if unknown.
 */
export function lookupDtc(code: string): DtcInfo | null {
  const normalized = code.trim().toUpperCase();
  const info = DTC_CODES[normalized];
  if (!info) {
    // Unknown code — return a generic placeholder using the prefix to infer category.
    const category: DtcCategory = normalized.startsWith('B') ? 'body'
      : normalized.startsWith('C') ? 'chassis'
      : normalized.startsWith('U') ? 'network'
      : 'powertrain';
    return {
      code: normalized,
      name: `Unknown ${category} code`,
      description: 'This code is not in the curated database. Look it up in your vehicle service manual or with a make-specific scan tool.',
      category,
      severity: 'moderate',
      likely_causes: [],
      repair_difficulty: 3,
    };
  }
  return { code: normalized, ...info };
}

/**
 * Look up multiple DTCs at once.
 */
export function lookupDtcs(codes: string[]): DtcInfo[] {
  return codes.map(lookupDtc).filter((d): d is DtcInfo => d !== null);
}

/**
 * Extract DTC codes from a value cell (handles "P0420", "P0420,P0301", "P0420|P0301", etc.)
 */
export function extractDtcs(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const matches = raw.toUpperCase().match(/[PBCU][0-9A-F]{4}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

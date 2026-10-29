import { describe, it, expect } from 'vitest';
import { parseCSV } from './csv-parser';
import { calculateFuelMetrics } from './fuel-metrics';
describe('fuel integration', () => {
  it('integrates flow and distance with real elapsed time', () => {
    const result = calculateFuelMetrics(parseCSV('Time,Fuel rate (L/h),Vehicle speed (km/h)\n0,3.6,36\n10,3.6,36\n20,3.6,36'));
    expect(result).toMatchObject({ coverage: 1, distanceCoverage: 1, fuelSeconds: 20 });
    expect(result.litres).toBeCloseTo(.02); expect(result.distanceKm).toBeCloseTo(.2);
  });
  it('handles interleaved observations in the original US export', () => {
    const result = calculateFuelMetrics(parseCSV('SECONDS;PID;VALUE;UNITS\n0;Calculated instant fuel rate;1;gal./h\n1;Vehicle speed;10;mph\n10;Calculated instant fuel rate;1;gal./h\n11;Vehicle speed;10;mph'));
    expect(result.fuelSeconds).toBe(10); expect(result.distanceSeconds).toBe(10);
    expect(result.litres).toBeCloseTo(3.785411784 / 360);
  });
  it('does not bridge explicit missing readings or long gaps', () => {
    const result = calculateFuelMetrics(parseCSV('Time,Fuel rate (L/h)\n0,3.6\n10,\n20,3.6\n60,3.6'));
    expect(result.litres).toBeNull(); expect(result.coverage).toBe(0);
  });
  it('accepts electric operation as zero flow but never invents a clock', () => {
    expect(calculateFuelMetrics(parseCSV('Time,Fuel rate (L/h)\n0,0\n10,0')).litres).toBe(0);
    expect(calculateFuelMetrics(parseCSV('Fuel rate (L/h)\n3.6\n3.6')).litres).toBeNull();
  });
});

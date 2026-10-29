import { describe, expect, it } from 'vitest';
import { analysisDisplay } from './analysis-display';

describe('AI report compatibility', () => {
  it('shows the findings and action returned by the current server', () => {
    expect(analysisDisplay({ summary: 'Hot', key_findings: ['Coolant high'], recommended_action: 'Stop safely' }))
      .toMatchObject({ summary: 'Hot', insights: ['Coolant high'], recommendations: ['Stop safely'] });
  });
  it('continues to show historical reports', () => {
    expect(analysisDisplay({ summary: 'Old', insights: ['Finding'], recommendations: ['Action'] }))
      .toMatchObject({ insights: ['Finding'], recommendations: ['Action'] });
  });
  it('does not render model-produced objects as React children', () => {
    expect(analysisDisplay({ summary: {}, key_findings: [null, {}, 'Valid'], recommended_action: [] }))
      .toMatchObject({ summary: '', insights: ['Valid'], recommendations: [] });
  });
});

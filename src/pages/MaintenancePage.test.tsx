import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import MaintenancePage from './MaintenancePage';
import i18n from '@/lib/i18n';
const mocks = vi.hoisted(() => ({ create: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/OilChangeCard', () => ({ OilChangeCard: () => null }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCarId: 'car', selectedCar: { name: 'Prius' } }) }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'mi', volumeUnit: 'US gal', consumptionUnit: 'MPG', currency: 'USD', timezone: 'America/New_York' }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/lib/db-extras', () => ({ listMaintenanceEvents: async () => [], createMaintenanceEvent: mocks.create, deleteMaintenanceEvent: vi.fn() }));
beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.create.mockReset().mockImplementation(async input => ({ ...input, id: 'oil', created_at: new Date().toISOString() }));
  mocks.toast.mockClear();
});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('records an oil change in miles and displays the saved mileage in miles', async () => {
  render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><MaintenancePage /></QueryClientProvider></MemoryRouter>);
  await screen.findByText('No services recorded yet');
  fireEvent.click(screen.getByRole('button', { name: 'Add a service' }));
  fireEvent.change(screen.getByLabelText('Odometer at service (mi)'), { target: { value: '150000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ car_profile_id: 'car', event_type: 'oil_change', odometer_km: 241402 }));
  expect(await screen.findByText('150,000 mi')).toBeInTheDocument();
});

it('uses the selected USD currency even when the interface is in Portuguese', async () => {
  await i18n.changeLanguage('pt-BR');
  render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><MaintenancePage /></QueryClientProvider></MemoryRouter>);
  await screen.findByText(i18n.t('maint.emptyTitle'));
  fireEvent.click(screen.getByRole('button',{name:i18n.t('maint.addButton')}));
  fireEvent.change(screen.getByLabelText(i18n.t('maint.costLabel')),{target:{value:'80'}});
  fireEvent.click(screen.getByRole('button',{name:i18n.t('common.save')}));
  await waitFor(()=>expect(mocks.create).toHaveBeenCalledOnce());
  expect(mocks.create.mock.calls[0][0]).toMatchObject({cost:80,currency:'USD'});
});

it('uses the selected timezone for the service date and its future-date validation', async () => {
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(new Date('2026-10-30T02:00:00Z')); // Still October 29 in New York.
  render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><MaintenancePage /></QueryClientProvider></MemoryRouter>);
  await screen.findByText('No services recorded yet');
  fireEvent.click(screen.getByRole('button',{name:'Add a service'}));
  expect(screen.getByLabelText('Date *')).toHaveValue('2026-10-29');
  fireEvent.change(screen.getByLabelText('Date *'),{target:{value:'2026-10-30'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({variant:'destructive'}));
});

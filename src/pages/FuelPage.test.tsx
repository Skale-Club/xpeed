import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { FuelEntry } from '@/lib/fuel-ledger';
import FuelPage from './FuelPage';
const settings=vi.hoisted(()=>({distanceUnit:'mi',volumeUnit:'US gal',consumptionUnit:'MPG',currency:'USD',timezone:'America/New_York'}));
const photo=vi.hoisted(()=>({prepare:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/fuel-receipt',()=>({prepareReceiptImage:photo.prepare,readFuelReceipt:photo.read,ReceiptError:class extends Error{}}));
const api = vi.hoisted(() => ({ save: vi.fn(), list: vi.fn(), toast: vi.fn(), entries: [] as FuelEntry[] }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCarId: 'car', selectedCar: { name: 'Prius', country: 'US' } }) }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => settings }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: api.toast }) }));
vi.mock('@/lib/db', () => ({ getSessions: async () => [] }));
vi.mock('@/lib/fuel-api', () => ({ listFuelEntries: api.list, saveFuelEntry: api.save, deleteFuelEntry: vi.fn() }));
vi.mock('recharts', () => ({ LineChart: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null, ResponsiveContainer: () => null }));
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ i18n: { resolvedLanguage: 'en' }, t: (_key: string, fallback: string) => fallback }) }));
beforeEach(() => {
  photo.prepare.mockReset().mockResolvedValue('data:image/jpeg;base64,ZmFrZQ==');
  photo.read.mockReset().mockResolvedValue({totalPaid:35.9,quantity:10,currency:'USD',volumeUnit:'US gal'});
  Object.assign(settings,{distanceUnit:'mi',volumeUnit:'US gal',consumptionUnit:'MPG',currency:'USD'});
  api.entries = [];
  api.list.mockReset().mockImplementation(async () => api.entries);
  api.save.mockReset().mockImplementation(async (_car, input) => { const entry = { ...input, id: 'new-entry' }; api.entries = [entry, ...api.entries]; return entry; });
  api.toast.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const open = () => render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><FuelPage /></QueryClientProvider></MemoryRouter>);
const addFill = async () => { await waitFor(() => expect(screen.getByRole('button', { name: 'Add a fill-up' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'Add a fill-up' })); };

it('starts with a summary and two clear actions, without a form, technical table or chart', async () => {
  open();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add a fill-up' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Set fuel price' })).toBeEnabled();
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'History & comparisons' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Is consumption changing?')).not.toBeInTheDocument();
});
it('records a fill-up using only payment and quantity, leaving extra fields optional', async () => {
  open(); await addFill();
  expect(screen.getByLabelText('Total paid')).toBeVisible();
  expect(screen.getByLabelText('Quantity')).toBeVisible();
  expect(screen.getByLabelText('Odometer (optional) (mi)')).not.toBeVisible();
  fireEvent.change(screen.getByLabelText('Total paid'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1]).toMatchObject({ kind: 'fill', litres: 37.85411784, totalPaid: 30, fullTank: false, odometerKm: null, currency: 'USD', source: 'receipt' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  const summary = screen.getByRole('heading', { name: 'This month' }).parentElement!;
  expect(within(summary).getByText('$30.00')).toBeInTheDocument();
});
it('saves a price independently without requiring a purchase quantity or creating actual spending', async () => {
  open();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Set fuel price' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Set fuel price' }));
  expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Fuel price' }), { target: { value: '3.50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1]).toMatchObject({ kind: 'reference', litres: 0, totalPaid: null, pricePerLitre: 3.5/3.785411784, currency: 'USD', source: 'manual' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByText('No fill-ups recorded this month')).toBeInTheDocument();
});
it('keeps a failed save in the form with its values and a visible retry message', async () => {
  open(); await addFill();
  fireEvent.change(screen.getByLabelText('Total paid'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
  api.save.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save. Your entries are still in the form.');
  expect(screen.getByLabelText('Total paid')).toHaveValue('30');
  expect(screen.getByLabelText('Quantity')).toHaveValue('10');
  expect(api.toast).not.toHaveBeenCalled();
});
it('keeps a typed price if the optional average lookup fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  open(); await waitFor(() => expect(screen.getByRole('button', { name: 'Set fuel price' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Set fuel price' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Fuel price' }), { target: { value: '3.50' } });
  fireEvent.click(screen.getByText('Use a U.S. average instead'));
  fireEvent.click(screen.getByRole('button', { name: 'Look up regional average' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The regional price is unavailable');
  expect(screen.getByRole('textbox', { name: 'Fuel price' })).toHaveValue('3.50');
  expect(api.save).not.toHaveBeenCalled();
});
it('opens comparisons only on request', async () => {
  open(); await screen.findByRole('button', { name: 'History & comparisons' });
  fireEvent.click(screen.getByRole('button', { name: 'History & comparisons' }));
  expect(await screen.findByText('Is consumption changing?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'History & comparisons' })).toHaveAttribute('aria-expanded', 'true');
});
it('preserves the actual timestamp so a new price in the same minute remains the latest', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T20:10:35.123Z'));
  api.entries = [{ id: 'old-price', kind: 'reference', at: '2026-10-29T20:10:05.123Z', litres: 0, totalPaid: null, pricePerLitre: 3.59/3.785411784, currency: 'USD', odometerKm: null, fullTank: false, source: 'manual', region: '', sourceUrl: '', note: '' }];
  open(); await screen.findByRole('button', { name: 'Change' });
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Fuel price' }), { target: { value: '3.50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1].at).toBe('2026-10-29T20:10:35.123Z');
  expect(await screen.findByText('$3.50 / US gal')).toBeInTheDocument();
});
it('accepts comma decimals from the phone keyboard and keeps Save disabled until both fields are filled', async () => {
  open(); await addFill();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByLabelText('Total paid')).toHaveAttribute('type', 'text');
  expect(screen.getByLabelText('Total paid')).toHaveAttribute('inputmode', 'decimal');
  fireEvent.change(screen.getByLabelText('Total paid'), { target: { value: '35,90' } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10,5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1]).toMatchObject({ totalPaid: 35.9, litres: 10.5 * 3.785411784 });
});

it.each([['km','US gal',37.85411784],['mi','L',10]])('records fuel independently of distance: %s with %s', async (distance, volume, litres) => {
  settings.distanceUnit=String(distance); settings.volumeUnit=String(volume);
  open(); await addFill();
  fireEvent.change(screen.getByLabelText('Total paid'),{target:{value:'30'}});
  fireEvent.change(screen.getByLabelText('Quantity'),{target:{value:'10'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1].litres).toBeCloseTo(Number(litres),8);
});

it('does not relabel a historical EUR price as USD when opening a new price record', async () => {
  api.entries=[{id:'eur',kind:'reference',at:'2026-10-29T10:00:00Z',litres:0,totalPaid:null,pricePerLitre:2,currency:'EUR',odometerKm:null,fullTank:false,source:'manual',region:'',sourceUrl:'',note:''}];
  open(); await screen.findByRole('button',{name:'Change'});
  expect(screen.getByText('€7.57 / US gal')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Change'}));
  expect(screen.getByRole('textbox',{name:'Fuel price'})).toHaveValue('');
  expect(api.entries[0].currency).toBe('EUR');
});

async function choosePhoto(){
  fireEvent.click(screen.getByRole('button',{name:'Fill from a photo'}));
  fireEvent.change(screen.getByLabelText('Choose photo'),{target:{files:[new File(['fixture'],'receipt.jpg',{type:'image/jpeg'})]}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Read this photo'})).toBeEnabled());
}
async function readPhoto(){await choosePhoto();fireEvent.click(screen.getByRole('button',{name:'Read this photo'}));await screen.findByText('Check what was read');}

it('requires review and an explicit Save, converting U.S. gallons into the chosen litre display',async()=>{
  settings.volumeUnit='L';open();await addFill();await readPhoto();
  expect(api.save).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();
  expect(screen.getByLabelText('Total on the photo')).toHaveValue('35.9');
  fireEvent.click(screen.getByRole('button',{name:'Use these values'}));
  expect(screen.getByLabelText('Quantity')).toHaveValue('37.854118');
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1]).toMatchObject({totalPaid:35.9,currency:'USD'});
  expect(api.save.mock.calls[0][1].litres).toBeCloseTo(37.85411784,5);
});
it('does not assume a currency or gallon standard missing from the photo',async()=>{
  photo.read.mockResolvedValue({totalPaid:35,quantity:10,currency:null,volumeUnit:null});
  open();await addFill();await readPhoto();
  expect(screen.getByRole('button',{name:'Use these values'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Currency',{selector:'#receipt-currency'}),{target:{value:'USD'}});
  expect(screen.getByRole('button',{name:'Use these values'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Unit on the photo'),{target:{value:'imperial gal'}});
  fireEvent.click(screen.getByRole('button',{name:'Use these values'}));
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1].litres).toBeCloseTo(45.4609,5);
});
it('keeps manually typed values when photo reading fails or is cancelled',async()=>{
  photo.read.mockRejectedValueOnce(new Error('network unavailable'));
  open();await addFill();
  fireEvent.change(screen.getByLabelText('Total paid'),{target:{value:'40'}});
  fireEvent.change(screen.getByLabelText('Quantity'),{target:{value:'11'}});
  await choosePhoto();fireEvent.click(screen.getByRole('button',{name:'Read this photo'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the photo');
  fireEvent.click(screen.getByRole('button',{name:'Close'}));
  expect(screen.getByLabelText('Total paid')).toHaveValue('40');expect(screen.getByLabelText('Quantity')).toHaveValue('11');
  expect(screen.getByRole('button',{name:'Save'})).toBeEnabled();expect(api.save).not.toHaveBeenCalled();
});
it('only fills fields actually found in a partial receipt',async()=>{
  photo.read.mockResolvedValue({totalPaid:35,quantity:null,currency:'USD',volumeUnit:null});
  open();await addFill();fireEvent.change(screen.getByLabelText('Quantity'),{target:{value:'11'}});
  await readPhoto();fireEvent.click(screen.getByRole('button',{name:'Use these values'}));
  expect(screen.getByLabelText('Total paid')).toHaveValue('35');expect(screen.getByLabelText('Quantity')).toHaveValue('11');
  expect(api.save).not.toHaveBeenCalled();
});
it('discards a late reading after cancellation and preserves the manual draft',async()=>{
  let finish!:(receipt:unknown)=>void;
  photo.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  open();await addFill();
  fireEvent.change(screen.getByLabelText('Total paid'),{target:{value:'40'}});
  fireEvent.change(screen.getByLabelText('Quantity'),{target:{value:'11'}});
  await choosePhoto();fireEvent.click(screen.getByRole('button',{name:'Read this photo'}));
  expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();
  const signal=photo.read.mock.calls[0][2] as AbortSignal;
  fireEvent.click(screen.getByRole('button',{name:'Close'}));
  expect(signal.aborted).toBe(true);
  await act(async()=>finish({totalPaid:500,quantity:100,currency:'USD',volumeUnit:'US gal'}));
  expect(screen.queryByText('Check what was read')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Total paid')).toHaveValue('40');expect(screen.getByLabelText('Quantity')).toHaveValue('11');
  expect(screen.getByRole('button',{name:'Save'})).toBeEnabled();expect(api.save).not.toHaveBeenCalled();
});
it('requires valid corrected values in the photo review',async()=>{
  open();await addFill();await readPhoto();
  fireEvent.change(screen.getByLabelText('Total on the photo'),{target:{value:'Infinity'}});
  expect(screen.getByRole('button',{name:'Use these values'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Total on the photo'),{target:{value:'35.90'}});
  fireEvent.change(screen.getByLabelText('Quantity on the photo'),{target:{value:'-1'}});
  expect(screen.getByRole('button',{name:'Use these values'})).toBeDisabled();
  expect(api.save).not.toHaveBeenCalled();
});

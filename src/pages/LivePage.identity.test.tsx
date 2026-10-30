import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import LivePage from './LivePage';
import i18n from '@/lib/i18n';

const h=vi.hoisted(()=>({select:vi.fn(),age:0,rpm:1450 as number|null}));
vi.mock('@/components/AppLayout',()=>({default:({children}:{children:ReactNode})=><div>{children}</div>}));
vi.mock('@/contexts/CarsContext',()=>({useCarsContext:()=>({selectedCar:{id:'b',name:'Car B'},selectedCarId:'b',cars:[{id:'a',name:'Car A',engine_type:'petrol'}],selectCar:h.select})}));
vi.mock('@/contexts/SettingsContext',()=>({useSettings:()=>({distanceUnit:'km',temperatureUnit:'C'})}));
vi.mock('@/contexts/ObdScannerContext',()=>({
  useObd:()=>({status:'live',connectedCarId:'a',connectedCarName:'Car A',channels:[{header:'Engine RPM (rpm)',name:'Engine RPM',unit:'rpm',min:0,max:6000,def:{pid:12}}],recording:null,getHistory:()=>[],connection:null}),
  useObdLive:()=>({receivedAt:Date.now()-h.age,cycleMs:100,values:{'Engine RPM (rpm)':h.rpm}}),
}));
afterEach(()=>{cleanup();h.age=0;h.rpm=1450;});
it('labels live readings with the connected car and offers an explicit switch from the selected car',async()=>{
  await i18n.changeLanguage('en');
  render(<MemoryRouter><LivePage /></MemoryRouter>);
  expect(screen.getByRole('heading',{name:/Car A/})).toBeInTheDocument();
  expect(screen.queryByRole('heading',{name:/Car B/})).not.toBeInTheDocument();
  expect(screen.getByRole('meter',{name:'Engine RPM'})).toHaveAttribute('aria-valuenow','1450');
  fireEvent.click(screen.getByRole('button',{name:'View connected car'}));
  expect(h.select).toHaveBeenCalledWith('a');
});

it('distinguishes a real zero from an absent reading',async()=>{
  await i18n.changeLanguage('en');
  h.rpm=0;
  const page=render(<MemoryRouter><LivePage /></MemoryRouter>);
  expect(screen.getByRole('meter',{name:'Engine RPM'})).toHaveAttribute('aria-valuenow','0');
  h.rpm=null;
  page.rerender(<MemoryRouter><LivePage /></MemoryRouter>);
  expect(screen.getByRole('meter',{name:'Engine RPM'})).not.toHaveAttribute('aria-valuenow');
  expect(screen.getByText('No reading')).toBeInTheDocument();
});

it('does not present an old reading as current when sensor cycles stop',async()=>{
  await i18n.changeLanguage('en');
  h.age=60000;
  render(<MemoryRouter><LivePage /></MemoryRouter>);
  expect(screen.getByRole('meter',{name:'Engine RPM'})).not.toHaveAttribute('aria-valuenow');
  expect(screen.getByTestId('reading-freshness')).toHaveTextContent('Readings paused');
});

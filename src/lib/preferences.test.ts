import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PREFERENCES_KEY, readPreferences, persistPreferences } from './preferences';
beforeEach(()=>localStorage.clear());
afterEach(()=>vi.restoreAllMocks());

it('migrates legacy fuel display once and does not tie it to a later distance change',()=>{
  localStorage.setItem('settings_distanceUnit','mi');
  const old=readPreferences();
  expect(old).toMatchObject({volumeUnit:'US gal',consumptionUnit:'MPG',currency:'USD'});
  persistPreferences({...old,distanceUnit:'km'});
  expect(readPreferences()).toMatchObject({distanceUnit:'km',volumeUnit:'US gal',consumptionUnit:'MPG'});
});
it('does not leave a partially saved set of units when the canonical write fails',()=>{
  const before=readPreferences(); persistPreferences(before);
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Storage full');});
  expect(()=>persistPreferences({...before,currency:'BRL',distanceUnit:'mi',volumeUnit:'US gal'})).toThrow('Storage full');
  expect(readPreferences()).toEqual(before);
});
it('reads the committed values even when legacy compatibility mirrors cannot be written',()=>{
  const write=Storage.prototype.setItem;
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this: Storage,key,value){
    if(key!==PREFERENCES_KEY)throw Error('Legacy mirror unavailable');
    write.call(this,key,value);
  });
  persistPreferences({...readPreferences(),timezone:'America/New_York',currency:'USD',volumeUnit:'US gal'});
  expect(readPreferences()).toMatchObject({timezone:'America/New_York',currency:'USD',volumeUnit:'US gal'});
});
it('recovers legacy units after a corrupt record and rejects invalid timezones',()=>{
  localStorage.setItem(PREFERENCES_KEY,'broken');
  localStorage.setItem('settings_distanceUnit','mi');
  localStorage.setItem('settings_timezone','not-a-zone');
  expect(readPreferences()).toMatchObject({distanceUnit:'mi',volumeUnit:'US gal'});
  expect(()=>new Intl.DateTimeFormat('en',{timeZone:readPreferences().timezone})).not.toThrow();
});

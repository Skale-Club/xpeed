import { vi } from 'vitest';
import { createFakeCar } from './fake-car';

// Fake Web Bluetooth for page tests: installs the simulated car (fake-car.ts)
// as navigator.bluetooth, with spies on the browser calls.

export { VIN } from './fake-car';

export function installFakeBluetooth(failConnects = 0) {
  const car = createFakeCar({ failConnects });
  const requestDevice = vi.fn(async () => car.device);
  const getDevices = vi.fn(async () => [car.device]);
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice, getDevices } });
  return {
    sent: car.sent,
    connectCalls: car.connectCalls,
    requestDevice,
    setCarOn: car.setCarOn,
    dropLink: car.dropLink,
    failNextConnects: car.failNextConnects,
    swapCar: car.swapCar,
    stall: car.stall,
    setVoltage: car.setVoltage,
    setPid: car.setPid,
    setStoredCodes: car.setStoredCodes,
  };
}

// Simulated car on "Bluetooth" for the screen-test copy: the same emulator as
// the tests, driving around (speed, RPM, coolant change over time) and with the
// real 2010 Prius 7E2/2181 reply so the HV battery blocks look realistic.

import { createFakeCar } from '@/test/fake-car';

const PRIUS_2181 = '6181' + '33AE336C3343336C3322335C335C336C330A335C3343339533 6C33BEADCA08CA0F'.replace(/\s/g, '');

function frames(hex: string): string {
  // ISO-TP style output with headers off: length line, then 0:, 1:, … frames.
  const bytes = hex.length / 2;
  const lines = [bytes.toString(16).toUpperCase().padStart(3, '0'), `0:${hex.slice(0, 12)}`];
  for (let i = 12, n = 1; i < hex.length; i += 14, n++) lines.push(`${(n % 16).toString(16).toUpperCase()}:${hex.slice(i, i + 14).padEnd(14, '0')}`);
  return lines.join('\r');
}

export function installHarnessCar() {
  if (typeof navigator === 'undefined') return;
  const car = createFakeCar({
    mode21: {
      '7E2': {
        '2181': () => frames(PRIUS_2181),
        '2174': () => '61744642414900' + '01C001C5',
      },
    },
  });

  // Gentle "driving": speed 0–70 km/h, RPM 0 (EV mode) – 2500, coolant warming up.
  let t = 0;
  setInterval(() => {
    t += 1;
    const speed = Math.max(0, Math.round(35 + 35 * Math.sin(t / 12)));
    const rpm = speed < 15 ? 0 : Math.round(1000 + speed * 20);
    const coolant = Math.min(88, 40 + t);
    car.setPid('0D', speed.toString(16).toUpperCase().padStart(2, '0'));
    car.setPid('0C', (rpm * 4).toString(16).toUpperCase().padStart(4, '0'));
    car.setPid('05', (coolant + 40).toString(16).toUpperCase().padStart(2, '0'));
  }, 1000);

  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: {
      requestDevice: async () => car.device,
      getDevices: async () => [car.device],
    },
  });
  // Handy from the browser console: __harnessCar.setCarOn(false)
  (window as unknown as { __harnessCar: typeof car }).__harnessCar = car;
}

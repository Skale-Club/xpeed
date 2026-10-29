import { describe, it, expect } from 'vitest';
import { bodyTypeFromNhtsa, carBodyType, colorHex, guessBodyType } from './car-look';

describe('car look', () => {
  it('reads the kind of car from the chassis number decoder', () => {
    expect(bodyTypeFromNhtsa('Hatchback/Liftback/Notchback')).toBe('hatch');
    expect(bodyTypeFromNhtsa('Sedan/Saloon')).toBe('sedan');
    expect(bodyTypeFromNhtsa('Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)')).toBe('suv');
    expect(bodyTypeFromNhtsa('Crossover Utility Vehicle (CUV)')).toBe('suv');
    expect(bodyTypeFromNhtsa('Pickup')).toBe('pickup');
    expect(bodyTypeFromNhtsa('Minivan')).toBe('minivan');
    expect(bodyTypeFromNhtsa('Wagon')).toBe('wagon');
    expect(bodyTypeFromNhtsa('Convertible/Cabriolet')).toBe('coupe');
    expect(bodyTypeFromNhtsa('Incomplete - Chassis Cab')).toBeNull();
    expect(bodyTypeFromNhtsa(null)).toBeNull();
  });

  it('guesses from the model name when there is no chassis number', () => {
    expect(guessBodyType('Prius')).toBe('hatch');
    expect(guessBodyType('Corolla')).toBe('sedan');
    expect(guessBodyType('Corolla Cross')).toBe('suv');
    expect(guessBodyType('Onix')).toBe('hatch');
    expect(guessBodyType('Onix Plus')).toBe('sedan');
    expect(guessBodyType('HB20S')).toBe('sedan');
    expect(guessBodyType('Hilux')).toBe('pickup');
    expect(guessBodyType('Strada')).toBe('pickup');
    expect(guessBodyType('Compass')).toBe('suv');
    expect(guessBodyType('Spin')).toBe('minivan');
    expect(guessBodyType('Mustang')).toBe('coupe');
    expect(guessBodyType('Some unknown thing')).toBeNull();
    expect(guessBodyType('')).toBeNull();
  });

  it("draws what the owner chose, else the guess, else a sedan; unknown colours are silver", () => {
    expect(carBodyType({ body_type: 'pickup', model: 'Corolla' })).toBe('pickup');
    expect(carBodyType({ body_type: null, model: 'Hilux' })).toBe('pickup');
    expect(carBodyType({ body_type: 'spaceship', model: 'Mystery' })).toBe('sedan');
    expect(colorHex('red')).toBe('#C8322F');
    expect(colorHex(null)).toBe(colorHex('silver'));
  });
});

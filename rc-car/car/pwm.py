"""Saída PWM para ESC e servo.

PCA9685 fala I2C direto via smbus2 (sem bibliotecas da Adafruit). DryRunPWM
serve para testar o servidor num PC, sem hardware.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger("rc-car.pwm")

MODE1 = 0x00
PRESCALE = 0xFE
LED0_ON_L = 0x06

MODE1_SLEEP = 0x10
MODE1_AUTO_INCREMENT = 0x20
MODE1_RESTART = 0x80


class PCA9685:
    def __init__(self, bus: int, address: int, frequency_hz: float, oscillator_hz: float) -> None:
        # Só existe no Pi; importar aqui deixa o dry-run rodar em qualquer PC.
        try:
            from smbus2 import SMBus
        except ImportError:
            from smbus import SMBus  # python3-smbus (i2c-tools): mesma API para o que usamos

        self.bus = SMBus(bus)
        self.address = address
        # O oscilador interno raramente é 25 MHz exatos; calibre em config.toml se os pulsos saírem tortos.
        prescale = round(oscillator_hz / (4096 * frequency_hz)) - 1
        self.tick_us = 1_000_000 * (prescale + 1) / oscillator_hz

        self.bus.write_byte_data(address, MODE1, MODE1_SLEEP)  # prescale só muda dormindo
        self.bus.write_byte_data(address, PRESCALE, prescale)
        self.bus.write_byte_data(address, MODE1, MODE1_AUTO_INCREMENT)
        time.sleep(0.005)
        self.bus.write_byte_data(address, MODE1, MODE1_RESTART | MODE1_AUTO_INCREMENT)
        log.info("PCA9685 em 0x%02x, %.0f Hz (prescale %d)", address, frequency_hz, prescale)

    def set_pulse_us(self, channel: int, pulse_us: int) -> None:
        ticks = max(0, min(4095, round(pulse_us / self.tick_us)))
        self.bus.write_i2c_block_data(self.address, LED0_ON_L + 4 * channel, [0, 0, ticks & 0xFF, ticks >> 8])

    def release(self, channel: int) -> None:
        """Desliga o sinal do canal (bit FULL_OFF). ESC sem sinal = motor parado."""
        self.bus.write_i2c_block_data(self.address, LED0_ON_L + 4 * channel, [0, 0, 0, 0x10])


class DryRunPWM:
    def __init__(self) -> None:
        self.pulses: dict[int, int] = {}

    def set_pulse_us(self, channel: int, pulse_us: int) -> None:
        if self.pulses.get(channel) != pulse_us:
            self.pulses[channel] = pulse_us
            log.debug("canal %d -> %d us", channel, pulse_us)

    def release(self, channel: int) -> None:
        self.pulses.pop(channel, None)
        log.debug("canal %d -> sem sinal", channel)


def open_pwm(cfg: dict, dry_run: bool):
    if dry_run:
        log.warning("modo dry-run: nenhum pulso real será enviado")
        return DryRunPWM()
    return PCA9685(
        bus=cfg["i2c_bus"],
        address=cfg["address"],
        frequency_hz=cfg["frequency_hz"],
        oscillator_hz=cfg.get("oscillator_hz", 25_000_000),
    )

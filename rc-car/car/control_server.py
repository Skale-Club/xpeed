#!/usr/bin/env python3
"""Servidor de controle do carrinho.

Recebe comandos do piloto (página web) por WebSocket e converte em pulsos
PWM para o ESC (acelerador) e o servo (direção) via PCA9685.

Segurança:
- sem comando por `failsafe_ms`, o acelerador volta para neutro sozinho;
- desarmado, o acelerador fica em neutro não importa o que chegue;
- um piloto por vez: quem conecta por último assume (reconexão pelo 4G
  não fica presa atrás de uma conexão antiga meio morta).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import signal
import time
import tomllib
from pathlib import Path

import websockets

from pwm import open_pwm

log = logging.getLogger("rc-car")


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def as_unit(value) -> float:
    """Número vindo da rede -> float finito em [-1, 1]. Lixo vira 0."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return clamp(v, -1.0, 1.0) if math.isfinite(v) else 0.0


class Car:
    def __init__(self, cfg: dict, pwm) -> None:
        self.thr = cfg["throttle"]
        self.steer = cfg["steering"]
        self.pwm = pwm
        self.throttle = 0.0
        self.steering = 0.0
        self.armed = False
        self.neutral()

    def throttle_us(self, t: float) -> int:
        c = self.thr
        if c.get("invert"):
            t = -t
        span = c["max_us"] - c["neutral_us"] if t >= 0 else c["neutral_us"] - c["min_us"]
        return round(c["neutral_us"] + t * span)

    def steering_us(self, s: float) -> int:
        c = self.steer
        if c.get("invert"):
            s = -s
        center = c["center_us"] + c.get("trim_us", 0)
        span = c["max_us"] - center if s >= 0 else center - c["min_us"]
        return round(center + s * span)

    def drive(self, t: float, s: float, armed: bool) -> None:
        self.armed = armed
        self.throttle = clamp(t, -self.thr["max_reverse"], self.thr["max_forward"]) if armed else 0.0
        self.steering = clamp(s, -1.0, 1.0)
        self.pwm.set_pulse_us(self.thr["channel"], self.throttle_us(self.throttle))
        self.pwm.set_pulse_us(self.steer["channel"], self.steering_us(self.steering))

    def neutral(self) -> None:
        self.drive(0.0, 0.0, armed=False)

    def release(self) -> None:
        self.neutral()
        self.pwm.release(self.thr["channel"])
        self.pwm.release(self.steer["channel"])


class ControlServer:
    def __init__(self, car: Car, failsafe_ms: int) -> None:
        self.car = car
        self.failsafe_s = failsafe_ms / 1000
        self.failsafe = True
        self.last_cmd = 0.0
        self.pilot = None

    async def handler(self, ws) -> None:
        previous, self.pilot = self.pilot, ws
        if previous is not None:
            log.warning("novo piloto %s assumiu o lugar de %s", ws.remote_address, previous.remote_address)
            # Sem await: fechar uma conexão morta no 4G pode levar segundos.
            asyncio.ensure_future(previous.close(4000, "outro piloto assumiu"))
        else:
            log.info("piloto conectou: %s", ws.remote_address)

        await ws.send(json.dumps({
            "type": "hello",
            "max_forward": self.car.thr["max_forward"],
            "max_reverse": self.car.thr["max_reverse"],
            "failsafe_ms": round(self.failsafe_s * 1000),
        }))
        try:
            async for raw in ws:
                if ws is not self.pilot:
                    continue  # conexão antiga que ainda não fechou
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "cmd":
                    self.on_command(msg)
                elif msg.get("type") == "ping":
                    await ws.send(json.dumps({
                        "type": "pong",
                        "ts": msg.get("ts"),
                        "t": self.car.throttle,
                        "s": self.car.steering,
                        "armed": self.car.armed,
                        "failsafe": self.failsafe,
                    }))
        except websockets.ConnectionClosed:
            pass
        finally:
            if self.pilot is ws:
                self.pilot = None
                self.failsafe = True
                self.car.neutral()
                log.info("piloto desconectou: neutro")

    def on_command(self, msg: dict) -> None:
        self.car.drive(as_unit(msg.get("t")), as_unit(msg.get("s")), armed=msg.get("armed") is True)
        self.last_cmd = time.monotonic()
        if self.failsafe:
            self.failsafe = False
            log.info("recebendo comandos")

    def check_failsafe(self, now: float) -> None:
        if not self.failsafe and now - self.last_cmd > self.failsafe_s:
            self.failsafe = True
            self.car.neutral()
            log.warning("sem comandos há mais de %d ms: neutro", round(self.failsafe_s * 1000))

    async def watchdog(self) -> None:
        while True:
            await asyncio.sleep(0.02)
            self.check_failsafe(time.monotonic())


async def run(cfg: dict, dry_run: bool) -> None:
    car = Car(cfg, open_pwm(cfg["pca9685"], dry_run))
    server = ControlServer(car, cfg["server"]["failsafe_ms"])

    main_task = asyncio.current_task()
    try:
        # systemd para o serviço com SIGTERM; sem isso o finally abaixo não roda.
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, main_task.cancel)
    except NotImplementedError:
        pass  # Windows (dry-run)

    host, port = cfg["server"]["host"], cfg["server"]["port"]
    try:
        async with websockets.serve(server.handler, host, port, ping_interval=5, ping_timeout=5, max_size=4096):
            log.info("controle ouvindo em ws://%s:%d", host, port)
            await server.watchdog()
    finally:
        car.release()
        log.info("PWM liberado")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("config.toml"))
    parser.add_argument("--dry-run", action="store_true", help="sem hardware: só registra os pulsos")
    parser.add_argument("-v", "--verbose", action="store_true", help="mostra cada pulso enviado")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    with args.config.open("rb") as f:
        cfg = tomllib.load(f)
    try:
        asyncio.run(run(cfg, args.dry_run))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

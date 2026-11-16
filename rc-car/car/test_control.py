"""Testes da lógica de segurança. Rode com: python -m unittest test_control.py"""
import tomllib
import unittest
from pathlib import Path

from control_server import Car, ControlServer, as_unit
from pwm import DryRunPWM

CFG = tomllib.loads(Path(__file__).with_name("config.toml").read_text(encoding="utf-8"))


def make_car():
    pwm = DryRunPWM()
    return Car(CFG, pwm), pwm


class CarTest(unittest.TestCase):
    def test_starts_in_neutral(self):
        _, pwm = make_car()
        self.assertEqual(pwm.pulses, {0: 1500, 1: 1500})

    def test_disarmed_ignores_throttle(self):
        car, pwm = make_car()
        car.drive(1.0, 0.5, armed=False)
        self.assertEqual(pwm.pulses[0], 1500)
        self.assertNotEqual(pwm.pulses[1], 1500)  # direção funciona desarmado, pra testar

    def test_throttle_capped_by_config(self):
        car, pwm = make_car()
        car.drive(1.0, 0.0, armed=True)
        self.assertEqual(pwm.pulses[0], 1500 + round(500 * CFG["throttle"]["max_forward"]))
        car.drive(-1.0, 0.0, armed=True)
        self.assertEqual(pwm.pulses[0], 1500 - round(500 * CFG["throttle"]["max_reverse"]))

    def test_steering_limits(self):
        car, pwm = make_car()
        car.drive(0.0, 1.0, armed=False)
        self.assertEqual(pwm.pulses[1], CFG["steering"]["max_us"])
        car.drive(0.0, -1.0, armed=False)
        self.assertEqual(pwm.pulses[1], CFG["steering"]["min_us"])

    def test_garbage_input_is_zero(self):
        for bad in (None, "x", float("nan"), float("inf"), [1]):
            self.assertEqual(as_unit(bad), 0.0)
        self.assertEqual(as_unit(5), 1.0)


class FailsafeTest(unittest.TestCase):
    def test_neutral_after_silence(self):
        car, pwm = make_car()
        server = ControlServer(car, failsafe_ms=300)
        server.on_command({"type": "cmd", "t": 1, "s": 0, "armed": True})
        self.assertGreater(pwm.pulses[0], 1500)

        server.check_failsafe(server.last_cmd + 0.2)
        self.assertGreater(pwm.pulses[0], 1500)

        server.check_failsafe(server.last_cmd + 0.31)
        self.assertEqual(pwm.pulses[0], 1500)
        self.assertTrue(server.failsafe)
        self.assertFalse(car.armed)

    def test_armed_must_be_literal_true(self):
        car, pwm = make_car()
        server = ControlServer(car, failsafe_ms=300)
        server.on_command({"type": "cmd", "t": 1, "s": 0, "armed": "yes"})
        self.assertEqual(pwm.pulses[0], 1500)


if __name__ == "__main__":
    unittest.main()

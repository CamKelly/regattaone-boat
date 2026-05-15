#!/usr/bin/env python3
"""
Live plot for SEN0140 `PLOT,...` CSV lines from UART.

Columns: ax,ay,az (g), gx,gy,gz (dps), mx,my,mz (mag raw), temp_c, press_hpa

Usage:
  pip install -r requirements-plot.txt
  # Close idf.py monitor (or any other app) on this port — only one client can open it.
  python3 plot_sen0140_serial.py -p /dev/tty.usbserial-XXXX
"""

from __future__ import annotations

import argparse
import sys
from collections import deque
from typing import Deque, List, Optional

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("Install deps: pip install -r requirements-plot.txt", file=sys.stderr)
    raise

import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation


def parse_plot_line(line: str) -> Optional[List[float]]:
    line = line.strip()
    if not line.startswith("PLOT,"):
        return None
    parts = line.split(",")
    if len(parts) != 12:
        return None
    out: List[float] = []
    for p in parts[1:]:
        p = p.strip().lower()
        if p in ("nan", ""):
            out.append(float("nan"))
        else:
            try:
                out.append(float(p))
            except ValueError:
                return None
    return out


def pick_default_port() -> Optional[str]:
    ports = list(serial.tools.list_ports.comports())
    if not ports:
        return None
    for p in ports:
        d = (p.device or "").lower()
        if "usb" in d or "acm" in d or "wchusbserial" in d:
            return p.device
    return ports[0].device


def main() -> None:
    ap = argparse.ArgumentParser(description="Plot SEN0140 PLOT CSV serial stream")
    ap.add_argument(
        "--port",
        "-p",
        default=None,
        help="Serial device (default: first USB-like port)",
    )
    ap.add_argument("--baud", "-b", type=int, default=115200)
    ap.add_argument("--window", type=int, default=120, help="Samples to keep")
    args = ap.parse_args()

    port = args.port or pick_default_port()
    if not port:
        print("No serial port found; pass --port", file=sys.stderr)
        sys.exit(1)

    labels = [
        "ax (g)",
        "ay (g)",
        "az (g)",
        "gx (dps)",
        "gy (dps)",
        "gz (dps)",
        "mx",
        "my",
        "mz",
        "T (C)",
        "P (hPa)",
    ]
    n_series = len(labels)
    maxlen = max(10, args.window)
    series: List[Deque[float]] = [deque(maxlen=maxlen) for _ in range(n_series)]
    x_times: Deque[int] = deque(maxlen=maxlen)

    ser = serial.Serial(port, args.baud, timeout=0.05)
    print(f"Reading {port} @ {args.baud}", file=sys.stderr)

    fig, axes = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
    fig.suptitle("SEN0140 (PLOT CSV)")
    groups = [
        (0, 3, axes[0], "Accel (g)"),
        (3, 6, axes[1], "Gyro (dps)"),
        (6, 11, axes[2], "Mag / temp / pressure"),
    ]
    lines: List = []
    for start, stop, ax, title in groups:
        ax.set_title(title)
        ax.grid(True, alpha=0.3)
        for i in range(start, stop):
            (ln,) = ax.plot([], [], label=labels[i])
            lines.append(ln)
        ax.legend(loc="upper right", fontsize=7, ncol=2)

    sample_n = 0

    def animate(_frame: int):
        nonlocal sample_n
        last: Optional[List[float]] = None
        while True:
            raw = ser.readline()
            if not raw:
                break
            text = raw.decode("utf-8", errors="replace")
            parsed = parse_plot_line(text)
            if parsed is not None:
                last = parsed
        if last is None:
            return lines

        sample_n += 1
        x_times.append(sample_n)
        for i, v in enumerate(last):
            series[i].append(v)

        xs = list(x_times)
        for i, ln in enumerate(lines):
            ln.set_data(xs, list(series[i]))
        for ax in axes:
            ax.relim()
            ax.autoscale_view()
        return lines

    FuncAnimation(fig, animate, interval=50, blit=False, cache_frame_data=False)
    plt.tight_layout()
    plt.show()
    ser.close()


if __name__ == "__main__":
    main()

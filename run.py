#!/usr/bin/env python3
"""Source-checkout entry point; installation is optional."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "python"))
from gpui_agent.cli import main

if __name__ == "__main__":
    raise SystemExit(main())

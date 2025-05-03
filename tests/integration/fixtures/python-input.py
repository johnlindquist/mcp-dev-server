#!/usr/bin/env python3
import sys
import time

print("[DEBUG] before prompt", file=sys.stderr)
print("What is your favorite color? ", end="", flush=True)
print("What is your favorite color? ", end="", file=sys.stderr, flush=True)
time.sleep(2)
print("[DEBUG] after prompt", file=sys.stderr)
name = sys.stdin.readline().strip()
print(f"Your favorite color is {name}.") 
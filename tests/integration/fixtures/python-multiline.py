#!/usr/bin/env python3
import sys
import time

print("[DEBUG] before first prompt", file=sys.stderr)
print("First name: ", end="", flush=True)
print("First name: ", end="", file=sys.stderr, flush=True)
time.sleep(2)
print("[DEBUG] after first prompt", file=sys.stderr)
first = sys.stdin.readline().strip()
print("[DEBUG] before second prompt", file=sys.stderr)
print("Last name: ", end="", flush=True)
print("Last name: ", end="", file=sys.stderr, flush=True)
time.sleep(2)
print("[DEBUG] after second prompt", file=sys.stderr)
last = sys.stdin.readline().strip()
print(f"Hello, {first} {last}!") 
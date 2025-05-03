#!/bin/bash

echo "[DEBUG] before prompt" >&2
echo -n "Enter your name: "
sleep 2
echo "[DEBUG] after prompt" >&2
read name
echo "Hello, $name!" 
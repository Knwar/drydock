#!/bin/sh
# Start the board daemon (HTTP + WS + overlay on 127.0.0.1:7890).
# Binds loopback by default so the daemon isn't reachable from the LAN; to expose
# it deliberately, launch with HOST=0.0.0.0 (all interfaces) or a specific IP.
cd "$(dirname "$0")/.." && exec npx tsx src/daemon/server.ts

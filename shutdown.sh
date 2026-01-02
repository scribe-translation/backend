#!/bin/bash
# Script to properly shut down the Firebase emulator and Node processes

echo "🛑 Shutting down services..."

# Kill Firebase emulator processes
pkill -f 'firebase.*emulators' || true

# Kill Node processes related to this project
pkill -f 'nodemon.*server.js' || true
pkill -f 'node.*server.js' || true

# Wait a moment for processes to terminate
sleep 1

# Force kill if still running
pkill -9 -f 'firebase.*emulators' 2>/dev/null || true
pkill -9 -f 'nodemon.*server.js' 2>/dev/null || true

echo "✅ Services shut down"


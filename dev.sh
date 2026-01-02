#!/bin/bash
# Wrapper script to start dev environment with proper signal handling

cd "$(dirname "$0")"

EMULATOR_PID=""
SERVER_PID=""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down services..."
    
    # Kill emulator if running
    if [ ! -z "$EMULATOR_PID" ] && kill -0 "$EMULATOR_PID" 2>/dev/null; then
        echo "🛑 Stopping Firebase emulator (PID: $EMULATOR_PID)..."
        kill -TERM "$EMULATOR_PID" 2>/dev/null || true
        # Wait up to 5 seconds for graceful shutdown
        for i in {1..5}; do
            if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done
        # Force kill if still running
        if kill -0 "$EMULATOR_PID" 2>/dev/null; then
            echo "⚠️ Force killing emulator..."
            kill -9 "$EMULATOR_PID" 2>/dev/null || true
        fi
    fi
    
    # Kill server if running
    if [ ! -z "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "🛑 Stopping development server (PID: $SERVER_PID)..."
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        # Wait up to 3 seconds for graceful shutdown
        for i in {1..3}; do
            if ! kill -0 "$SERVER_PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done
        # Force kill if still running
        if kill -0 "$SERVER_PID" 2>/dev/null; then
            kill -9 "$SERVER_PID" 2>/dev/null || true
        fi
    fi
    
    # Clean up any remaining processes
    pkill -f 'firebase.*emulators' 2>/dev/null || true
    pkill -f 'nodemon.*server.js' 2>/dev/null || true
    
    echo "✅ Services shut down"
    exit 0
}

# Trap signals
trap cleanup SIGINT SIGTERM EXIT

# Start emulator in background
echo "🔥 Starting Firebase emulator..."
npm run emulator &
EMULATOR_PID=$!

# Wait for emulator to start
echo "⏳ Waiting for emulator to initialize..."
sleep 5

# Check if emulator is still running
if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
    echo "❌ Emulator failed to start"
    exit 1
fi

# Start server in foreground (so we can see output)
echo "🚀 Starting development server..."
FIRESTORE_EMULATOR_HOST=localhost:8181 NODE_ENV=dev nodemon server.js &
SERVER_PID=$!

# Wait for server process (this will block until it exits)
wait $SERVER_PID


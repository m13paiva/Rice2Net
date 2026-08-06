#!/bin/bash

# --- CONFIGURATION ---
# Replace these with the actual absolute paths to your directories.
FRONTEND_DIR="/home/m13paiva/Desktop/network_rendering"
BACKEND_DIR="/home/m13paiva/Desktop/network_rendering/server"

echo "Cleaning up any old server instances..."
pkill -f "node server.js"
pkill -f "python3 -m http.server 8000"

echo "Starting Neo4j Database Service..."
# This requires sudo privileges. You may be prompted for your password.
sudo systemctl start neo4j

echo "Starting Node.js Backend..."
cd "$BACKEND_DIR" || { echo "Failed to find backend directory. Did you update the path?"; exit 1; }
# Run in the background
node --max-old-space-size=8192 server.js &

echo "Starting Frontend HTTP Server..."
cd "$FRONTEND_DIR" || { echo "Failed to find frontend directory. Did you update the path?"; exit 1; }
# Run in the background
python3 -m http.server 8000 &

echo "Waiting for services to initialize..."
sleep 3

echo "Opening Web App and Neo4j Browser..."
# xdg-open is the standard Linux command to open the default web browser
xdg-open "http://localhost:8000"
xdg-open "http://localhost:7474"

echo "Done. Both servers are running in the background."

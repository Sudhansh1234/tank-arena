# 🪖 Tank Arena

Multiplayer top-down tank battle. Drive, aim with the mouse, and blast your friends.
Built with Node.js + WebSockets.

## Run locally
```bash
npm install
npm start
```
Open http://localhost:3001

## Controls
Move **WASD** · Aim **mouse** · Shoot **click / Space**. Each tank picks one weapon
(Cannon ricochets, MG, Shotgun, Railgun phases through walls) before the match.

## Play with friends
- **Same WiFi:** friends open `http://YOUR-LAN-IP:3001` and enter your room code.
- **Over the internet:** deploy to Render (below) for a permanent public URL.

## Deploy to Render (free)
1. Push this repo to GitHub.
2. Go to https://render.com → **New → Blueprint** → pick this repo → **Apply**.
   Render reads `render.yaml` and deploys (Node web service, WebSocket-ready).
3. Share the `https://<name>.onrender.com` link with friends.

## Features
- 3 maps (Crossfire / Maze / Arena), destructible crates, pickups (health/shield/speed/damage)
- 4 weapons, kill feed, scoreboard, respawns, room codes, reconnect

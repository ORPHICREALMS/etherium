# Age of Etherion: multiplayer server

One small Node program that does three things:

- serves the game page at `/`
- answers `/health` (Render's health check)
- runs the relay on a WebSocket at `/ws`

The server does **not** run the game. Every player's browser runs the whole game. The server puts everybody's commands into one numbered order (10 turns a second) and sends the same turns to everyone. So everybody plays the exact same game. It also keeps a snapshot and a short log, so someone who closed the tab or lost their connection can come back with **Rejoin Game** and step into the live game.

If every player leaves, the game freezes and waits. Rooms are kept for 6 hours after the last player leaves.

## Run it on your own computer

    cd server
    npm install
    node server.js          # then open http://localhost:8080

## Put it on Render (when you are ready)

1. Put this whole folder in a GitHub repo. A repo with just the `server` folder works, and so does the whole project if you set Root Directory to `server`.
2. On render.com choose **New, then Web Service**, and pick the repo.
   - Runtime: Node
   - Root Directory: `server` (leave empty if the repo root is this folder)
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Health Check Path: `/health`
   - Plan: Free
3. Deploy. Your game is at `https://<name>.onrender.com`. Everybody opens that link in Chrome, presses **Multiplayer**, and one person creates a room and shares the 4-letter code.

(`render.yaml` here describes the same settings. If you want Render to read it as a Blueprint, copy it to the repo root.)

Notes:
- The free plan goes to sleep after about 15 minutes with nobody connected. The first visit afterwards takes about 30-60 seconds to wake it. A game in progress does not lose anything while people are connected. If the server restarts or sleeps, games in progress are lost.
- Opening the game from a file on your computer works for single player and the Test Lobby only. Online play needs the web address.
- To update the game: run `node build.js <version>` in the project. It refreshes `server/public/index.html` and `server/mpcore.js`. Commit and push, and Render redeploys.
- Everyone in a game must be on the same version of the page. Because the server serves the page itself, that is automatic, as long as people reload the page after an update.

## Tests

`t_mp_net.js` starts 2-4 real browsers against a local server, plays, closes a tab, rejoins, and drops a connection, and compares the game state of every player. Run the server with `SNAP_EVERY=150 PORT=8099 node server.js` first.

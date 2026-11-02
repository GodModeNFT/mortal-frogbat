# Mortal Frogbat — Telegram Mini App

Kiki (red-eyed tree frog) vs Riri (cane toad). Same move set, different frogtalities.
Each lobby holds 2 fighters, and everyone else who joins spectates live.

## How it works
- `public/index.html` is the whole game: rendering, sound, CPU opponent and online client. Opened on its own, it plays offline vs CPU.
- `server.js` serves the game, validates Telegram users and runs the rooms. It relays both players' inputs frame by frame (lockstep).
  Every player and spectator runs the same deterministic fight from the same seed. Everyone sees the identical fight and the identical randomly picked frogtality.
- `bot.js`: one pit per chat. The first `/duke` opens it with **Join** and **Spectate** buttons. Any extra `/duke` while that pit is waiting or mid-fight gets a "Game lobby is already live" notice pointing at it. After 15 seconds the bot deletes both the notice and the extra `/duke`.
  The first fighter to tap Join gets a **Choose your fighter** screen (Kiki or Riri, showing their saved skin for each, with a Change skin button). If they don't pick within 30 seconds they get Kiki. The next fighter in automatically gets the other one.
  Each pit is one match, with no rematches. When it ends, the bot posts the winner and the next `/duke` opens a new pit. If a fighter leaves mid-fight, the other wins by forfeit.

## Setup (about 15 minutes)
1. **Create the bot.** In @BotFather, send `/newbot` and copy the token.
2. **Host the server** anywhere that runs Node 18+ with HTTPS, such as Railway, Render, Fly.io or a VPS behind Caddy.
   ```
   npm install
   BOT_TOKEN=123:abc BOT_USERNAME=YourFrogBot APP_SHORT_NAME=pit npm start
   ```
3. **Create the Mini App.** In @BotFather, send `/newapp`, pick your bot, set the Web App URL to your HTTPS address (e.g. `https://frogbat.up.railway.app/`), and set the short name to `pit` (it must match `APP_SHORT_NAME`).
4. **Allow group commands.** In @BotFather, `/setjoingroups` → Enable. Add the bot to your public chat and **make it an admin with "Delete messages"**. It needs that to clean up extra /duke spam after 15 seconds.
5. In the chat, type `/duke`. Tap **Join** to fight or **Spectate** to watch. The first two to join fight.

## Deploy on a VPS (RackNerd) with Cloudflare Tunnel
1. Push this folder to a GitHub repo.
2. In Cloudflare **Zero Trust → Networks → Tunnels**, create a tunnel (type Cloudflared) and copy its token from the install command.
   Add a **Public Hostname**, for example `frogbat.yourdomain.com`, with service `HTTP` and `localhost:3000`.
3. SSH into the VPS as root and run:
   ```
   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy/install.sh | bash
   ```
   It asks for the repo URL, bot token, bot username and tunnel token, then installs Node, the game service and the tunnel.
   For a private repo, run it as `GIT_TOKEN=<token> bash install.sh` after downloading it.
4. In @BotFather `/newapp`, set the Web App URL to `https://frogbat.yourdomain.com` and the short name to `pit`.
5. To update later, push to GitHub and run the same command again.

## Local test without Telegram
```
npm run dev          # ALLOW_GUESTS=1, no bot
open http://localhost:3000/?room=test&name=Aiman   (in two browser tabs)
```
To test inside Telegram from your machine, tunnel it with `ngrok http 3000` and use the ngrok HTTPS URL in `/newapp`.

## Profile page
- Every /duke post (the lobby post and the "Game lobby is already live" reply) has a **🏆 Profile · Skins · Leaderboard** button. Typing /duke while a lobby is open or live just shows that reply (which cleans up after 15 seconds), so the profile is always one /duke away.
- It opens the game straight to the player's profile with no fight: their photo, @name, rank, record and frogtalities, both fighters in their current skins with progress to the next unlock, a **Change skin** button for each, and the full **Leaderboard**.
- Opening the Mini App with no lobby link (for example from the bot's profile) also lands on this page.
- **Fight section** (when the profile was opened from a group): shows that group's pit live, refreshing every few seconds.
  - No fight: **Start a game** opens a lobby, posts the normal /duke message in the group ("opened by @name"), and puts you in with first pick of Kiki or Riri. Only members of that group can start one.
  - Lobby waiting: who's in, plus **Join** and **Spectate**.
  - Fight in progress: who's fighting, plus **Spectate**.
  - After a fight ends, a **Profile** button takes players back to their profile.
- Group keys used in profile links are saved in `DATA_DIR/chats.json`.

## Leaderboard
- After every match, the server saves each fighter's Telegram @username (or first name if they have none), wins, losses and frogtalities.
- Forfeits count as a loss for whoever left.
- Data lives in `DATA_DIR/stats.json`. On the VPS that's `/var/lib/frogbat/stats.json`, which survives updates and restarts.
- Profile photos come from Telegram through the bot (`getUserProfilePhotos`), are cached in `DATA_DIR/avatars` for 24 hours, and are served at `/avatar/<key>`. The key never reveals the Telegram id or bot token. Players whose photo privacy hides it from bots, or who have no photo, show their initial instead.
- Before every fight, a VS screen shows both players' photos and @names. During the fight, each photo sits beside that player's health bar.
- In the game, tap **Leaderboard** to see everyone ranked by wins, with your own row highlighted. The server also serves it as JSON at `/leaderboard`.

## Skins
Each fighter has 7 unlockable skins on top of its classic look. Skin N unlocks after a set number of wins **as that fighter**. The first fighter into a pit picks Kiki or Riri, and the next fighter gets the other one:

| Skin | Wins | Kiki | Riri |
|---|---|---|---|
| 1 | 3 | Lime Squeeze | Mud Puddle |
| 2 | 9 | Poison Dart | Fire-Belly |
| 3 | 15 | Bandana Bandit | Swamp Brute |
| 4 | 26 | Glass Frog | Toxic Waste |
| 5 | 32 | Shadow Ninja | Bone Armor |
| 6 | 50 | Inferno | Frost Titan |
| 7 | 100 | Golden God | Cosmic Overlord |

- Progress and the equipped skin save to each player's profile in `stats.json`. Open **Skins** in the game to see progress and wear unlocked skins. The new skin shows from the next fight, and everyone watching sees it.
- When a win unlocks a skin, the winner sees NEW SKIN UNLOCKED on the end screen and the bot adds a line to the result post.
- Forfeit wins only count toward skins if the fight lasted 20+ seconds, so two accounts can't farm instant wins.
- The server checks every equip request, so a locked skin can't be worn.
- Only the Classic look is unlocked at the start. Every other skin shows its requirement ("Win 9 matches as Kiki (3/9)") and can't be worn until it's earned.
- The offline preview follows the same rules using wins against the CPU, kept on that device only. The CPU always wears the Classic look.

## Controls
Keyboard + mouse: A/D move, Space (or W) jump, Shift crouch, left click punch, right click kick, middle click or E tongue, S block (shield), F frogtality. Arrow keys and J/K/L/I also work.
Phone: put your thumb anywhere on the left side and slide (left/right move, up jump, down crouch, no lifting needed). On the right: big PUNCH and KICK (slide between them), BLOCK (hold), TONGUE, and F · FROGTALITY, which lights up when they're on the last chunk. Down + PUNCH is uppercut, down + KICK is sweep, same as PC. Turn the phone sideways and the controls float over the arena. Every press gives a haptic buzz, and swipe-to-close is turned off while playing.
Health: 250 per fighter (one match, so it lasts longer), 99-second clock.
Moves: punch (ducking dodges it), kick, Shift+left click uppercut, Shift+right click sweep, jump then right click flying kick, tongue lash (pulls them in), block (15% chip damage). After a knockdown (uppercut or sweep), the frog that gets up has 1 second where it can't be hit (it blinks), so it can jump away, walk off or block. Attacking ends that protection early.
One round decides the match. The health bar is split into 10 chunks. When your opponent is down to the last chunk (10% or less), the game flashes FINISH HIM! and pressing F (or the F button on phones) pulls them into one of your 3 frogtalities, picked at random. Kill them with a normal hit instead and they just die, and the match ends with no frogtality.

## Arenas
Each match picks one of 6 arenas at random from the match seed, so both fighters and every spectator see the same one. The VS screen shows its name.
Swamp Temple (midnight) · Bayou Docks (sunset) · Lily Pad Arena (midday) · Bone Bog (foggy dawn) · Flooded Graveyard (storm, rain and lightning) · Glowshroom Grove (twilight).
To add or remove arenas, or change their odds, edit the `STAGES` list and `stagePick` in the game script.

## Sound and music
- Flooded Graveyard plays a light, looping rain sound. Its thunder plays with each lightning strike.
- **Match music:** "Not Like Apu" (`public/music/not-like-apu.mp3`) starts from the beginning of every match, on every map, and loops. It plays fairly quietly (volume 0.143, about 7 dB above the graveyard rain) under the hits and announcer.
- **Music on/off** and **Sound on/off** buttons sit under the arena. Music off stops just the music; Sound off silences everything. Both are remembered on that device and, inside Telegram, saved to the player's Telegram account so they carry over to their other devices.
- To give one map its own track instead, put the file in `public/music/` and set that map's `music:'file.mp3'` in the `STAGES` list. To change the match track or its volume, edit `MATCH_MUSIC` and `MUSIC_VOL`.

## Frogtalities
- Kiki: Spine Snatch, Acid Bath, Bloat
- Riri: Lily Pad Splat, Swallowed Whole, Head Hop

## Tuning
- Move damage, speed and reach: the `MOVES` table at the top of the script. Both frogs share it.
- Online input delay: `DELAY` in the online section (3 frames). Raise it to 4–5 if players on bad mobile data see stutter.

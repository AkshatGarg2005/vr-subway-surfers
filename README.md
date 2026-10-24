# Metro Rush

An endless three-lane runner set in a city rail yard: dodge trains, jump hurdles,
roll under barriers, run along train roofs, grab coins and power-ups, and stay
ahead of the warden and his robot dog.

One codebase, four ways to play:

| Mode | What you need |
|---|---|
| **Desktop** | Any modern browser (Chrome, Safari, Firefox). Keyboard. |
| **Phone** | Android Chrome or iOS Safari. Swipes. |
| **Phone VR** | A phone in a Cardboard-style headset. You change lanes by stepping sideways, and jump and roll by really jumping and crouching. Head tracking is for looking around only. A Bluetooth gamepad works as a backup. |
| **WebXR headset** | For example a Quest, in its browser. Step or lean to change lanes, jump and crouch for real. Controllers work too. |

Everything is made in code: models from primitives, textures painted on a canvas
with noise, sounds synthesised with WebAudio. There are no asset files: once
three.js has downloaded from the CDN, the game builds itself in under a second.

## Running it

You need [Node.js](https://nodejs.org/) 18 or newer (the test tools need Node 22+).
There is nothing to install.

```sh
node server.js
```

The server prints its addresses:

```
Metro Rush on http://localhost:8080  (desktop)
             https://localhost:8443

On your phone (same Wi-Fi), open:
   https://192.168.1.10:8443
```

- **Desktop:** open <http://localhost:8080>.
- **Phone or headset:** open the `https://<your-computer's-LAN-IP>:8443` address it
  prints. The phone and the computer must be on the same Wi-Fi.

### Why HTTPS, and the certificate warning

Phones only give motion sensors (and WebXR) to secure pages. On first run the
server makes a self-signed certificate with `openssl` covering `localhost`,
`127.0.0.1` and every LAN address of your computer (it's stored in `.cert/`, which
is never served; it is remade automatically if your LAN address changes).

Because the certificate is self-signed, the browser warns you once:

- **iPhone / iPad Safari:** "This Connection Is Not Private" → **Show Details** →
  **visit this website** → **Visit Website**.
- **Android Chrome:** "Your connection is not private" → **Advanced** →
  **Proceed to 192.168.x.x (unsafe)**.
- **Quest browser:** **Advanced** → **Proceed**.

If your computer's firewall asks, allow Node to accept incoming connections.

Server options: `--port 8080`, `--https-port 8443`, `--no-https`, `--quiet`.

### Phone VR, step by step

1. Open the `https://` address on the phone and tap **Phone VR**.
2. Allow motion access if asked (iPhone asks; Android usually doesn't).
3. Turn the phone sideways and put it in the headset. Stand with some room
   around you (about a metre each side).
4. **First time only: calibration.** The headset shows four short steps:
   *Stand still*, *Jump once*, *Crouch once*, *Step to one side, then back to the
   middle*. Tapping the screen (or the headset's button) skips a step.
   Calibration can only make detection more sensitive, never less, so a big
   calibration jump won't make small hops get missed later.
5. A 3-second countdown: *stand tall, look straight ahead*. The view recenters
   just before "go".

To redo the calibration later: pause (the ❚❚ button at the top left of the
screen) → **Recalibrate body sensing**.

### WebXR headset

Open the `https://` address in the headset's browser and press **Enter VR** (the
button only appears when the browser supports immersive VR). Stand in the middle
of your play space, facing where you want to run, during the countdown: that
position and direction become "centre" and "forward".

## Controls

| | Desktop | Phone | Phone VR | WebXR headset |
|---|---|---|---|---|
| **Change lane** | ← → or A D | swipe left / right | **step sideways** (a quick step or a small hop), one lane per step; gamepad d-pad or stick as a backup | **step or lean sideways**: where your head is (more than 25 cm from centre) picks the lane; thumbstick as a backup |
| **Jump** | ↑, W or Space | swipe up | **jump for real**; tap the screen or gamepad A as a backup | **jump for real**; trigger as a backup |
| **Roll** | ↓ or S | swipe down | **crouch for real**; gamepad B as a backup | **crouch for real**; grip as a backup |
| **Look around** | — | — | move your head (looking only) | move your head (looking only) |
| **Pause** | P or Esc | ❚❚ button | ❚❚ button (top left of the screen) | — |
| **Recenter** | — | — | look up past ~55° and hold for 2 s (a ring of dots fills in), or long-press the screen (0.7 s), or the button in the pause menu | thumbstick click |
| **Run again** (game over) | Space / Enter | tap | jump (after 1.5 s), tap or gamepad A | jump (after 1.5 s) or trigger |

**Lanes never follow head rotation.** In VR, turning, tilting or nodding your head
only looks around. The track is straight, so a head-driven control would fire every
time you looked at something.

Gamepads (any standard-mapping Bluetooth or USB pad) work in every mode: d-pad or
left stick for lanes, A/Y jump, B/X roll, Start pause, Select recenter.

## How to play

- Score is distance × multiplier; each coin is worth 5 × multiplier. The multiplier
  goes up every 750 m.
- **Low hurdle** (red and white board): jump it. Hitting one makes you stumble.
- **High barrier** (striped sign with a gap underneath): roll under it.
- **Tall barrier** and **trains**: change lane. Running into the front of a train
  ends the run; scraping its side makes you stumble and bounce back.
- **Ramps** lead up onto train roofs. Running off the end of a roof drops you back
  onto the track.
- Some trains are **moving** toward you (headlights on).
- A **stumble** slows you down and brings the warden right behind you. A second
  stumble within 7 seconds and he catches you.
- **Power-ups:** magnet (12 s, pulls coins in), 2× score (15 s), super sneakers
  (20 s, higher jumps), board shield (absorbs one crash or stumble).
- **Hints** (on by default): "Jump" / "Roll" appears dimmed as a warning, then
  lights up with a tick sound when it's time to act. In VR, hints come earlier
  (body moves take longer to detect) and also say "Step left / right" when a train
  or tall barrier blocks your lane.

## Settings (title screen)

| Setting | What it does |
|---|---|
| Sound | Music and effects on/off. |
| Hints | The Jump / Roll / Step cues. |
| Camera | Desktop and phone: chase camera or first person. (VR is always first person.) |
| Body sensing | Phone VR sensitivity: Low, Normal or High. |
| VR speed | Gentle (2.5 → 4 m/s), Normal (3 → 5, the default; tested comfortable in a phone headset), Brisk (4 → 6.5) or Fast (5 → 8). |
| Comfort vignette | Narrows the view slightly during lane changes and climbs, in VR. |

Settings, the best score and the body-sensing calibration are saved in the browser.

## Body sensing tips (phone VR)

- **Side-steps:** step about **20–40 cm** to the side, briskly (roughly a third to
  half a second), and keep your head facing forward while you do. One step = one
  lane. Step back toward the middle to come back: a step right then a step left
  returns you to the centre lane, matching where you physically stand. A step
  toward an edge lane you're already in does nothing, which also brings your body
  and the game back in sync.
- Steps smaller than ~15 cm or very slow drifts are deliberately ignored, as are
  head turns, tilts, nods and gentle swaying.
- **Jumps:** a small hop is enough; you don't need to jump high. The jump is
  detected as you leave the ground (typically 50–70 ms after take-off).
- **Rolls:** duck down quickly by about 30 cm or more. Standing back up is not
  mistaken for a jump.
- If the view drifts sideways over time, look up for 2 seconds to recenter.
- Make sure the phone is snug in the headset: a loose phone rattles.

## Troubleshooting

| Problem | Fix |
|---|---|
| "No motion data" panel in phone VR | The page must be the **https://** address (not http). Allow motion access when asked. On iPhone: Settings › Apps › Safari › Advanced › Motion & Orientation Access (older iOS: Settings › Safari › Motion & Orientation Access), then reload. On Android Chrome: tap the lock icon › Site settings › Motion sensors › Allow. You can also choose **Play without body sensing** and use the screen tap or a gamepad. |
| The phone can't open the page | Same Wi-Fi as the computer? Use the IP address the server printed, with `https://` and `:8443`. Check the computer's firewall. |
| Jumps are missed | Set Body sensing to **High**, or recalibrate with a normal small hop. Make sure the phone is snug. |
| Lanes change by themselves | Set Body sensing to **Low**; keep your head facing forward while stepping; recenter (look up for 2 s). |
| The view is tilted or points the wrong way | Recenter: look up for 2 s, long-press the screen, or use the pause menu. |
| "Rotate your phone" | Phone VR plays in landscape; turn the phone sideways (and unlock rotation). |
| Choppy on an older phone | The game lowers its resolution automatically within about 10 seconds; give it a moment before the run starts. |
| No sound | Tap the screen once (browsers only start audio after a tap), and check the Sound setting and the phone's silent switch. |

Add `?debug` to the address (for example `https://192.168.1.10:8443/?debug`) to see
live sensor values, detection thresholds, the last detected move, frame rate and
resolution.

## Performance

- **Resolution:** pixel ratio at most 2 on a normal screen and 1.7 in phone VR
  (starting at 1.5). Multisampling is only used when the device pixel ratio is
  below 1.5: at Retina or phone density it costs more than it shows.
- **Automatic quality** watches frame times in 2-second windows. If more than 8 %
  of frames are late, or even the fastest frames take over 20 ms, it steps down:
  multisampling, then resolution (in proportion to how slow it was), in phone VR
  bloom before going below 1.25, then lower resolution, then (normal screen)
  sun shafts. It only steps back up after 30 s of smooth frames, never back to a
  level that failed, and waits 3 s after each change. It also runs during menus,
  calibration and the countdown, so changes happen before the run.
- Everything repeated (sleepers, rails, props, coins, trains...) is drawn through
  instanced pools that **draw only the slots in use**.
- The AudioContext is created while loading and only resumed on the first tap,
  and every shader is compiled before the loading screen goes away.
- No allocations in the per-frame hot paths; the world uses a floating origin so
  coordinates stay small on long runs.

Measured on an M2 MacBook Air (headless Chrome with the real GPU):

| | Result | Target |
|---|---|---|
| Desktop, Retina (2880×1800) | 60 fps, p95 18.8 ms, worst frame in 3 min 20.8 ms; ~105 fps uncapped | 60 fps |
| JavaScript per frame, desktop | 0.74 ms | ≤ 2 ms |
| Phone VR (emulated 915×412 phone @2.625, 4× CPU throttle) | at most 176k triangles per stereo frame; 44 draw calls per eye (83 for the eye that also draws the shadow map) | ≤ 250k; ≤ 200 per eye |
| Simulated slow phone GPU | settles in 5–10 s, one step back up | ~10 s, at most one |

Where the time goes in one Retina frame with the sun in view (`framecost`
scenario, 2880×1800): 9.0 ms in total, of which post-processing is 5.0 ms (bloom
2.75), shadows 1.5 ms and the track 1.5 ms. Cost follows the pixel count
(2.7 ms at pixel ratio 1, 5.3 ms at 1.5, 9.0 ms at 2), which is why the automatic
quality works on resolution first.

Real-device numbers (a mid-range phone in a headset, a Quest) need a real device:
see "Not yet verified" below.

## Tests and tools (`tools/`)

None of these are loaded by the game. They need Node 22+ and, for `drive.mjs`,
Google Chrome (set `CHROME=/path/to/chrome` if it isn't in the usual place).

| Command | What it checks |
|---|---|
| `node tools/solvable.mjs` | Generates 5 km of track for several seeds at each mode's minimum and maximum speed, with and without super sneakers, and proves it's playable with the game's own physics: every row has a passable lane; lane changes between rows are reachable in time without cutting through a train; every hurdle's jump window, every barrier's roll window and a clean ride up every ramp; and a full-length path search. Fails with the seed and distance of any impossible spot. `--what-if vr.jumpV=7,vr.gravity=40` tries tuning changes before you make them. |
| `node tools/motion-sim.mjs` | Synthetic accelerometer bench for phone-VR body sensing: jumps, non-jumps (still, rattle, nodding, looking around, marching, heel raises, crouches with hard stand-ups), side-steps, and head movements that must not change lanes, delivered five ways (exact 60 Hz, jittered, batched, Chrome under load, soft sensor), with and without calibration. `--seed N`, `--verbose`. |
| `node tools/xr-sim.mjs` | Head-tracking gestures for WebXR headsets: steps and leans, jumps, crouches, and head movements that must not trigger anything. |
| `node tools/drive.mjs <scenario>` | Drives the game in headless Chrome over the DevTools Protocol (Node's built-in `fetch` and `WebSocket`). Flags: `--uncapped` (no vsync, to measure real cost), `--mobile` (915×412 @2.625, touch, Android user agent, 4× CPU throttle), `--headful`, `--arg key=value`. Screenshots go to `tools/shots/`. It starts `server.js` itself if nothing is listening on :8080. |

Scenarios for `drive.mjs` (in `tools/scenarios/`):

| Scenario | |
|---|---|
| `autopilot` | 60 s autopilot run: average fps, p95 frame time, frames over 25/50 ms, quality changes. `--arg invincible=false` to allow deaths. |
| `soak` | Long run with real deaths and restarts in one mode: `--arg mode=screen\|cardboard\|xr --arg seconds=180`. |
| `cardboard` | Phone-VR run (use `--mobile`): triangles and draw calls per stereo frame and per eye, frame times, and a CPU profile (`--arg profile=1`). |
| `eyecheck` | Over 500+ phone-VR frames, compares how washed out each eye is, to catch a broken eye. `--arg fault=washR` breaks one eye on purpose to show the check works. |
| `framecost` | A frozen frame with the sun in view: the cost of each part (sky, track, trains, shadows, bloom, sun shafts, all post-processing, pixel ratios), each switched off on its own. Use with `--uncapped`. |
| `slowgpu` | Simulated slow GPU (busy-wait per pixel, more with bloom): the automatic quality must settle without bouncing. |
| `jsprofile` | JavaScript time per frame (CPU profiler). |
| `hitches` | Every frame over 25 ms during a run. |
| `pools` | Instanced pools: capacity vs drawn vs live. |
| `bodysense` | End-to-end body sensing in the browser with synthetic sensor events: calibration, then jump, roll and side-steps (`--arg flip=1` for iOS-style accelerometer signs). |
| `recenter` | The look-up recenter gesture. |
| `nosensor` | The "no motion data" help and "play without body sensing". |
| `xrmode` | WebXR mode with a stubbed head pose and controllers. |
| `vrhint` | The phone-VR "Step left / right" cue when a train blocks your lane. |
| `look`, `moments`, `death` | Screenshots for reviewing the look. |
| `stumble`, `info`, `probe`, `texprofile` | Smaller checks. |

Test-only URL flags: `?autopilot`, `?invincible`, `?seed=N`, `?autostart`, `?debug`.
`window.__game` exposes `{ game, renderer, view, input, ... }` for tools.

## Not yet verified

These need real hardware, which the automated tools can't provide:

- Phone VR on a real phone in a headset (feel of the body-sensing thresholds, real
  sensor noise, frame rate after automatic quality settles on a mid-range phone).
- A real WebXR headset session (Quest): session start, controllers, 72 fps. The
  headset code is tested with a stubbed head pose (`xrmode` scenario) and its
  gestures with `xr-sim.mjs`.
- Safari and Firefox on desktop, and iOS Safari (only Chrome was automated).

## File map

```
index.html        page, import map (three@0.169.0), menus and HUD markup
style.css         UI styles (safe areas, reduced motion)
app.js            boot: renderer, textures, world, modes; the main loop
server.js         HTTP :8080 + HTTPS :8443 dev server, self-signed certificate

js/config.js      constants, lanes, physics per mode, rules, platform detection, helpers
js/physics.js     player body, jumping/rolling/lane changes, collision rules (no three.js)
js/patterns.js    seeded pattern generator with in-code fairness checks (no three.js)
js/game.js        rules, run states, scoring, power-ups, chase, hints, cameras, autopilot
js/world.js       chunked track, obstacles, coins, power-ups, floating origin
js/pool.js        instanced pools that draw only used slots
js/builders.js    procedural models (trains, barriers, ramps, props, coins, power-ups)
js/textures.js    procedural canvas textures (colour + normal + ORM maps)
js/materials.js   shared materials
js/characters.js  the runner, the warden and the robot dog, animated in code
js/atmosphere.js  sky shader, sky-tinted fog, city skyline, sun and shadows, environment map
js/render.js      post-processing, phone-VR stereo, sun projection
js/quality.js     automatic quality
js/particles.js   pooled particles (coin sparkles, dust, sparks)
js/audio.js       WebAudio music and sound effects
js/ui.js          DOM menus and the normal-screen HUD
js/hud3d.js       in-world VR HUD panels
js/input.js       keyboard, swipe, tap, long-press, gamepad, phone sensors
js/vr.js          phone VR: head tracking, recentering, VR camera, session
js/motion.js      real jump / crouch / side-step detection from motion sensors (no three.js)
js/sensing.js     sensor adapter, calibration flow, ?debug overlay
js/headgestures.js WebXR jumps, crouches and lanes from head position (no three.js)
js/xr.js          WebXR session, controllers, camera rig

tools/drive.mjs        Chrome DevTools Protocol driver
tools/scenarios/       scenario scripts run inside the page
tools/solvable.mjs     track solvability checker
tools/motion-sim.mjs   synthetic accelerometer bench
tools/xr-sim.mjs       WebXR head-gesture bench
```

## Originality

Metro Rush is inspired by the endless-runner genre and copies nothing from any
existing game: the characters (a skater kid with a backpack, a rail-yard warden and
a robot dog), the art, the music and the sounds are all original and generated in
code. Graffiti is abstract shapes and colours, never real tags, brands or text.

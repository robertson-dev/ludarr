# The project: what it is, what it does, how to reach it, how to deploy it

Written 2026-11-12; "Using the repos" added and the state brought up to date on 2026-11-21. This is the standalone guide
to the whole project: the engine (this repository), Ahoy and the Ahoy launcher. It holds no password, key or token;
where one is needed it says where the owner keeps it.

Contents: [What it is](#1-what-it-is) · [What it does](#2-what-it-does) · [How it is built](#3-how-it-is-built) ·
[Where it runs](#4-where-it-runs) · [Connecting](#5-connecting) · [Deploying](#6-deploying) ·
[Operating it](#7-operating-it) · [Working on the code](#8-working-on-the-code) ·
[Using the repos](#9-using-the-repos) · [State and known gaps](#10-state-and-known-gaps)

## 1. What it is

A self-hosted game library for the owner and a few friends. Someone asks for a game; the server finds it, downloads it,
makes it ready to run on a Windows PC, and the desktop app installs and starts it with one press. Console and arcade
games are played through an emulator, a port or a recomp that the server sets up by itself.

It is three codebases:

| Part | On disk | GitHub (private) | Branch in use | Role |
|---|---|---|---|---|
| **Ludarr** (playarr, then arcadearr, until 2026-11-21) | `ludarr` | `robertson-dev/ludarr` | `arcadearr-ways` | The engine, in the style of Sonarr and Radarr. |
| **Ahoy** | `ahoy` (`server/`, `web/`) | `robertson-dev/ahoy` | `redesign` | The players' server and pages. |
| **Ahoy launcher** | `ahoy/launcher` (a git repo nested in the Ahoy folder) | `robertson-dev/ahoy-launcher` | `launcher-0.13.0` | The Windows desktop app. |

## 2. What it does

### From a request to a game

1. **Request.** A player asks for a game in Ahoy (from its store-like pages, a search, or by tracking a release day). A
   game that came out on several platforms asks which version is wanted.
2. **Search.** The engine asks the indexers (through Prowlarr) and ranks what they have: is this certainly that game, is
   it a form that can be installed, does it fit the game's profile. A wrong game is treated as far worse than no game.
3. **Download.** The release goes to a download client on the seedbox (rTorrent or NZBGet). The owner's own sync brings
   finished downloads to the server, and the engine takes them from that folder in place.
4. **Import.** Fixed recipes unpack archives and disc images, run installers under wine, lay a release's crack over the
   install, drop installer leftovers, check the result and pick the program that starts the game. The AI importer is
   called only when the recipes cannot finish.
5. **Package.** The finished copy is hashed and indexed in blocks, so installs are fast and an update downloads only
   what changed.
6. **Install and play.** The launcher installs it, verifies it, keeps saves, and starts it.

### Console and arcade games

A game asked for in a console's version, or whose console copy arrives, gets a **way to play** by itself: the console's
emulator is fetched, set up portable with its first-run windows answered ahead, and the game is handed to it on the
command line. `README.md` has the table of which emulator plays which console and what each needs from the owner once
(a BIOS, keys). Recomps and ports are made from a repository address, by the built-in list where it knows the project
and by the AI importer otherwise.

A **carry run** takes a way from its plan to an installable game with no click and asks the owner only when it must:
which game a plan plays, a file it cannot get, a need that is missing. On a run's ask, **This is wrong** lets the owner
tell the AI in their own words what the plan has wrong.

### What players get in Ahoy

Accounts by invite, friends and what they are playing, discovery (coming soon, new and trending, top sellers, best-of
lists, more like this), installing on another of their PCs, games that install by themselves when they arrive, saves
that follow them between PCs with earlier versions kept on the server, a note of what changed after an update, and a
big-screen mode driven by a controller.

## 3. How it is built

```
 player's PC                         the server (Unraid, Docker)                        outside
+-----------+   session    +----------------+   API key    +------------------+     +-------------+
|  launcher | -----------> |  Ahoy :8790    | -----------> |  ludarr :7979   | --> |  Prowlarr   |
| (Electron)|  packages    |  accounts, UI  |   proxied    |  search, import, |     |  seedbox    |
+-----------+ <----------- |  discovery     | <----------- |  packages, ways  |     |  forges     |
                           +----------------+              +------------------+     +-------------+
```

- The launcher talks only to Ahoy, with a user's session. Package bytes go launcher to Ahoy to ludarr, so the engine's
  key never reaches a PC.
- Ahoy keeps the engine's address and key in its own database; its admin enters them once. Players never see the
  engine or its words.
- All three are TypeScript on Bun. The servers are Hono with SQLite; both web pages are React and Vite; the launcher is
  Electron with its own updater.

The engine's vocabulary: a **game** is a library entry; a **request** is one search; a **fetch** is one download; an
**import job** turns a download into an installed game; a **package** is the finished copy; a **plan** says how to get,
set up and start a program that plays games; a **way** ties one game to one plan with its game file; a **carry run**
carries a way through.

## 4. Where it runs

One Unraid server on the owner's network, plain Docker (the box has no `docker compose` plugin).

| | |
|---|---|
| Host | Unraid 7.3.1 at `<server>`, Docker 29 |
| Engine | container `ludarr`: admin page and API at `http://<server>:7979` |
| Ahoy | container `ahoy` at `http://<server>:8790`; public at `https://ahoy.example.com` through the Nginx Proxy Manager container on the same box |
| Prowlarr | container `binhex-prowlarr`, host port 9696 |
| Seedbox | a remote box with ruTorrent and NZBGet; the owner's own rclone sync moves its finished downloads to the server |

This server was set up before the engine was renamed. Where this guide says `ludarr` for the container, its image, its
Unraid template, its appdata folder, its env file and its SSD staging folder, the server still has `playarr`:
`LUDARR_CONTAINER` in `deploy/.env.site` says so, and the engine reads what it finds under the old name
(`src/former.ts`: variables, the database file, saved settings, backups). Those names change only when they are moved
on the server.

### The two containers

| | `ludarr` | `ahoy` |
|---|---|---|
| Image | `ludarr:latest`; the one before the last deploy stays tagged `ludarr:prev` | `ahoy:latest`; `ahoy:prev` |
| Port | `7979:7979` | `8790:8790` |
| Flags | `-d --init --restart unless-stopped` | `-d --init --restart unless-stopped` |
| Environment | `--env-file /mnt/user/appdata/ludarr/ludarr.env` (the secrets: Prowlarr, seedbox, AI), `PORT=7979`, `LUDARR_GAMES=/library`, `LUDARR_WORK=/library/.work` | `PORT=8790`, `AHOY_CONFIG=/config`; no env file |
| Config and database | `/mnt/user/appdata/ludarr` → `/config` (`ludarr.db`, `backups/`, `plugins/`) | `/mnt/user/appdata/ahoy` → `/config` (`ahoy-app.db`, `backups/`, `launcher/`, `art/`) |
| Library | the library folder (`LUDARR_GAMES_HOST`, default `/mnt/user/games/ludarr`) → `/library` | none |
| Downloads | `/mnt/user/downloads/ahoy` → `/downloads` | none |
| Seedbox mount | `/mnt/addons/seedbox` → `/remote` (`rw,rslave`; an rclone mount set up by `deploy/seedbox-mount.py`) | none |
| Finished downloads | the folder the owner's sync fills (`LUDARR_ARRIVALS_HOST`, default `/mnt/user/downloads/finished`) → `/arrivals`; imported from in place | none |
| Build folder on the box | `/mnt/user/appdata/ludarr-build` | `/mnt/user/appdata/ahoy-build` |
| Unraid template | `/boot/config/plugins/dockerMan/templates-user/my-ludarr.xml` (source `unraid/my-ludarr.xml`) | `.../my-ahoy.xml` (source `unraid/my-ahoy.xml` in the Ahoy repo) |
| Health | `GET /api/health` | `GET /api/health` |

The exact `docker run` line for each is in that repo's `deploy/unraid.py`. The engine's image is large because it
carries what imports and ways need: wine (64 and 32 bit) under a virtual display, the unpackers, a build toolchain,
sandbox users, and software OpenGL and Vulkan for checks.

### SSD staging and import recovery

In Ludarr, **Settings → Media Management → SSD staging folder** accepts a writable mounted directory. On this Unraid server, `/ssd` maps to `/mnt/cache/ludarr-staging`. New seedbox transfers land in `/ssd/downloads`. Imports and recipe builds use `/ssd/work`. After verification, Ludarr publishes the package to the game's root folder on the array. Downloads already waiting in the shared arrivals folder continue there. Clear the setting to use the configured downloads and work folders again.

After a restart, an interrupted job checks for completed archive extractions, converted game data, and a pending transfer of a verified package. An archiver interrupted inside an archive may need to read that archive again. To retry a completed download that Ludarr rejected, open the game and choose **Use a download**. Pick **Regular import** or the intended way to play. The selection applies to this attempt and keeps the original download.

### Where the secrets are

| Secret | Where it lives |
|---|---|
| Unraid root password | With the owner. Never in a repo; given to a deploy command through the environment. |
| Prowlarr, seedbox and AI keys | `/mnt/user/appdata/ludarr/ludarr.env` on the box, and the engine's Settings pages. |
| The engine's API key | The engine's database; shown and changed under Settings, General. Ahoy holds a copy in its settings. |
| Console keys and BIOS files | Uploaded once to the plan that needs them (Settings, Runtimes); kept in the engine's content store. |
| Players' sessions | Ahoy's database; the launcher keeps its own sealed. |

### Rules for that box

- `downloads/finished` is shared with the owner's Sonarr and Radarr: touch only what the engine itself took there, and mount
  nothing broader than that folder into the engine.
- Do not change Unraid's own settings or edit the owner's sync scripts.
- Ask before deleting live data. Never create accounts on the live Ahoy. Never change the owner's desktop shortcuts.

## 5. Connecting

**The pages.** The engine's admin page is `http://<server>:7979` (it is the admin's alone). Ahoy is
`http://<server>:8790` on the network and `https://ahoy.example.com` from outside; friends join there with an invite
code and download the launcher from its front page.

**SSH.** `root@<server>`, port 22, by password, which the owner has.

**Looking around without changing anything:**

```
docker ps
docker logs --tail 200 ludarr
docker exec ludarr ls /config /config/backups
```

Both databases are SQLite files under each container's `/config`. The engine's image has Bun, so a read-only query is a
small script run with `docker exec ludarr bun <file>` that opens the database with `{ readonly: true }`.

**The engine's API.** Everything is under `http://<server>:7979/api/v1/` and needs the header `X-Api-Key`.
`docs/api.md` lists every route. The ones that answer most questions, all read-only:

| Question | Route |
|---|---|
| Is it up, which version | `GET /api/health`, `GET /api/v1/system/status` |
| A game, its copy, its search | `GET /api/v1/game`, `GET /api/v1/game/:id` |
| Why an import failed | `GET /api/v1/import/:id` (its log, the AI's recorded steps, its lesson) |
| What is blocklisted and why | `GET /api/v1/blocklist` |
| Plans and what they need | `GET /api/v1/plan` |
| What a run is doing or asking | `GET /api/v1/runs`, `GET /api/v1/run/:id` |
| How a copy starts, and its programs | `GET /api/v1/game/:id/launch` |

**Ahoy's API.** `http://<server>:8790/api/v1/`, with a signed-in user's session.

## 6. Deploying

Each repository has `deploy/unraid.py`. It packs the source (no secrets, no `node_modules`), uploads it over SFTP, runs
`docker build` on the box, installs the Unraid template, recreates the container and waits for `/api/health`.

```
UNRAID_HOST=<server> UNRAID_USER=root UNRAID_PASS=... python deploy/unraid.py
```

Without `UNRAID_PASS` the script logs in with the SSH keys of the machine it runs from. It keeps the image the
container ran as `:prev`, stamps the commit on the new image, and with `DEPLOY_LABEL=<word>` also tags it
`<word>-<commit>`. It needs Python 3 with `paramiko` on the machine it runs from. In Git Bash on Windows prefix it with
`MSYS_NO_PATHCONV=1`, or container paths such as `/library` are rewritten into Windows paths. The engine's script takes
overrides from the environment (`LUDARR_PORT`, `LUDARR_GAMES_HOST`, `LUDARR_DOWNLOADS_HOST`, `LUDARR_REMOTE_HOST`,
`LUDARR_ARRIVALS_HOST`, `LUDARR_NET`); the defaults are the paths in the table above.

The server's address and its own folders are not written in the repositories. Each deploy script reads
`deploy/.env.site` beside it when it is there: `KEY=VALUE` lines (`UNRAID_HOST`, and for the engine
`LUDARR_CONTAINER`, `LUDARR_GAMES_HOST` and `LUDARR_ARRIVALS_HOST`), ignored by git. The environment wins over the file, and the
password is never read from it. The engine's template in the repo names default folders; the copy installed on the
box names the ones the deploy mounts. A deploy refuses to give a running container another library or
finished-downloads folder than it has, unless `LUDARR_ALLOW_MOVE=1` says the move is meant.

How a deploy is done here, on top of the script:

1. **From a clean checkout of a tested commit**: `git worktree add --detach <folder> <commit>`, with the test suite and
   the typecheck green at that commit. Never from a working tree that has edits in it.
2. **Wait until the engine is idle**: no job running and no player downloading.
3. **Back up the database first**, consistently: `VACUUM INTO /config/backups/<name>-<stamp>-pre-<label>.db`.
4. **Tag the running image `:prev`** before the new one replaces it.
5. **Check health**, then check the thing that changed, read-only.

Rolling back is recreating the container from the `:prev` image with the same `docker run` line, and, if the data was
changed, putting the backup back while the container is stopped.

When both servers change, deploy the engine first and Ahoy after it.

**The launcher is published by Ahoy's deploy.** It takes the newest `Ahoy-Setup-*.exe` in `launcher/release/` (with
`latest.yml` and the blockmap) into `<appdata>/launcher/`, and every installed launcher then updates itself. A build
that is only to be tried is built into `launcher/release-next/` and copied to `release/` only when it is to go out:

```
bun run build && electron-builder --win nsis --publish never -c.directories.output=release-next
```

## 7. Operating it

Most of this is in the engine's admin page; the route is given for scripting.

| To do | Where | Route |
|---|---|---|
| See why a game is not there yet | the game's page: status, History, Jobs | `GET /api/v1/game/:id`, `GET /api/v1/import/:id` |
| Search again now, forgetting what was tried | Activity, Queue: Retry | `POST /api/v1/queue/:id/retry?fresh=1` |
| Take a release off the blocklist | Activity, Blocklist | `DELETE /api/v1/blocklist/:id` (never without an id: that clears the list) |
| Change which program starts a game | the game's page: Starts with | `PUT /api/v1/game/:id/launch`, `DELETE` to reset |
| Choose which platform's version is looked for | the game in Ahoy: Platform, Change | `PUT /api/v1/game/:id { platform }` |
| Give an emulator its BIOS or keys | Settings, Runtimes: the plan's needs | `POST /api/v1/plan/:id/needs/:i/file?name=` |
| Give a way its game file | the run's ask: upload, pick on the server, or the game's inbox folder | `POST /api/v1/content`, `POST /api/v1/content/path` |
| Add a way to play from a repository | Add New, a repository | `POST /api/v1/plan/construct` |
| Answer or correct a run | the run's ask on the game's Ways to play tab | `POST /api/v1/run/:id/answer`, `.../retry`, `.../tell` |

Things that look after themselves: the engine backs up its database daily, rescans the library, looks for new releases
of wanted games every 15 minutes, gives console copies a way to play at start and once a day, and starts carry runs for
ways that are not built.

### Simulating imports

In the Ludarr admin page, **Settings → Importers → Import simulator** runs the production importer and package validator on a disposable miniature release. Choose the scripted reference for a free, offline check or the configured AI to test an instruction over at most six model calls. Compare the expected outcome, verdict and tool results. The sample shell supports only the fixed local copy described in the exercise. Nothing is published.

Open a completed job log and expand **Simulate this job** to compare a recorded decision with the current model. Pick a turn and optionally add a trial instruction. One model call sees the recorded brief and earlier observations. Proposed shell commands, searches, downloads and changes are displayed only. A failed build or make job without an AI trace uses its recorded failure and log to propose a first recovery step. Text-only playback omits screenshots. Older recordings reconstruct the prompt from the current toolbox and omit historical lessons. Trial instructions apply only to the simulation.

From the engine checkout, run `bun run simulate` for the offline regression suite. It exercises fixture imports, reuse of earlier downloads, converter cache repairs, portability checks, and assembly. A failure exits nonzero. When a production incident exposes a new bug, add the smallest fixture that fails before the fix and include it in this suite.

For end-to-end trials on the Docker host, run `bash helpers/import-lab/run.sh /tmp/ludarr-import-results` from a checkout. The lab generates eleven miniature releases, including executable Windows programs, nested archives, updates, a wrong title and two PS5 folder layouts. It runs each through the installed Ludarr image in a fresh network-disabled container with a private database and a read-only fixture. Only the configured AI provider is contacted, by a separate relay, up to nine model calls per case. Each case keeps a JSON record with its recipe results, AI tool trace, published file hashes and independent verdict.

Append `--agent-only` before the case names to try the AI first on Windows releases. Add `--smoke` before the case names to launch published Windows packages under Wine. For example, `bash helpers/import-lab/run.sh /tmp/ludarr-import-comparison --agent-only --smoke build-path wrong-title patch-only`. The batch exits 0 when every case passes, 1 for an import or package mismatch, and 2 for an inconclusive trial. The PS5 fixtures test intake only. No fixture contains commercial game data.

## 8. Working on the code

**Needed on the machine:** Bun; Python 3 with `paramiko` for deploys; Node's Electron comes with the launcher's own
dependencies.

| | Run | Test | Typecheck | Build |
|---|---|---|---|---|
| Engine (`ludarr`) | `bun run dev` | `bun test ./tests` | `bun ./node_modules/typescript/bin/tsc --noEmit -p .` | the image builds the admin page; by hand `cd web && bun run build` writes `public/` |
| Ahoy server (`ahoy/server`) | `bun run dev` | `bun test ./tests` | same | `bun run build:web` |
| Ahoy pages (`ahoy/web`) | `bun run dev` (port 8791) | `bun test ./tests/` | same | `bun run build` |
| Launcher (`ahoy/launcher`) | `bun run start` | `bun test`, `bun run smoke` (hidden window) | same | `bun run dist` |

The launcher's `e2e` runs against a live server and needs a real account's password, so it is the owner's to run.

**Where things are in the engine:**

| Folder | What |
|---|---|
| `src/requests.ts`, `src/releases.ts` | searching, ranking and picking a release; the wanted platform |
| `src/process/` | imports: `recipes.ts`, `scene.ts` (installers and cracks), `classify.ts`, `validate.ts` (the final check and the program that starts a game), the AI importer |
| `src/ways/` | plans, ways and carry runs: `construct.ts` (plans from a repository and the AI's rounds), `carry.ts` (the run), `recipes.ts` (the emulator per console), `find.ts` (a way's game file) |
| `src/catalog/` | what exists and how it can be played: the emulator list, ports, compatibility lists |
| `src/library/`, `src/api/` | the library and the HTTP routes |
| `web/` | the admin page |
| `deploy/`, `unraid/` | the deploy script, the seedbox mount, the Unraid template |

**How changes are made here:**

- A fault found on the server gets a general fix, with a test replayed from what the server recorded, not a special case
  for one game.
- Rules first, the AI after: whatever the AI works out is kept as data the rules can run next time.
- A wrong game is far worse than no game: nothing is taken on a name alone.
- Players never see the engine's own words; Ahoy translates them (`server/src/words.ts`).
- Every setting in a settings page does something.
- Every player-visible change gets a line in Ahoy's `web/src/whatsnew.ts`.
- Commit messages say what was asked, what changed, what was checked and what was not.

## 9. Using the repos

### Who owns them

All three repositories are private and belong to the GitHub account `robertson-dev`. They were moved there from another
account on 2026-11-21; the old addresses redirect. The owner's PC is signed in to git and `gh` as that earlier
account, which is a collaborator with push rights on all three. Pushing works from there. Settings, renames, collaborators and
deleting a repository are done as `robertson-dev`.

### Getting them onto a machine

The engine's folder is `ludarr`, and the launcher's repository sits inside Ahoy's folder (Ahoy's `.gitignore` leaves
`launcher/` alone):

```
git clone -b arcadearr-ways  https://github.com/robertson-dev/ludarr.git        ludarr
git clone -b redesign        https://github.com/robertson-dev/ahoy.git          ahoy
git clone -b launcher-0.13.0 https://github.com/robertson-dev/ahoy-launcher.git ahoy/launcher
```

### Branches

Each repository has one branch that work happens on. `main` is what GitHub shows on the repository's front page; it
is moved up to the working branch (a fast-forward) when the owner says so:

| Repository | Work happens on | `main` |
|---|---|---|
| `ludarr` (the engine) | `arcadearr-ways` | the same commit as the working branch on 2026-11-21 |
| `ahoy` | `redesign` | the same commit as the working branch on 2026-11-21 |
| `ahoy-launcher` | `launcher-0.13.0` | the same commit as the working branch on 2026-11-21 |

- Start from the working branch. What runs on the server is built from the working branches.
- The launcher gets a branch per version, `launcher-<version>`, cut from the one before it. The newest is the one in
  use.
- Between those moves `main` lags behind. A banner, a README or a name that looks old on GitHub is `main` not having
  been moved up yet.
- **The history starts on 2026-11-21.** On the owner's word each repository was reduced that day to one commit holding
  that day's files. The earlier commits went, and with them the launcher's branches for versions 0.10.0 to 0.12.0 and
  two engine branches that existed only on the owner's PC. A commit id from before that day, in an older document or
  stamped on an image, names nothing in the repositories now.

### Commits

- A commit is made when the owner asks for one, not as a by-product of a change.
- A change to the launcher is committed in `ahoy/launcher`, which is its own repository; Ahoy's repository never sees
  it. A change that touches several repositories is one commit in each.
- The author is `robertson-dev` with that account's GitHub no-reply address. It is set in each checkout
  (`git config --local user.name` and `user.email`); the owner's PC has no machine-wide identity, so a fresh clone needs
  it set before its first commit.
- The subject line says what changes, in plain words ("Keep card accents tied to their own artwork"). The body follows
  the rule in section 8: what was asked, what changed, what was checked and what was not.
- Stage files by name. Build output, databases, logs, `.env` files and the launcher's `release/` folders are ignored
  by each `.gitignore`, but stray files do sit in the folders. No password, key or token goes into a commit.

### Pushing

- A push is made when the owner asks for one: `git push origin <branch>`, the working branch only.
- History that has been pushed is not rewritten, unless the owner says so in as many words (as on 2026-11-21, when it
  was removed).
- What runs on the server is on GitHub. A commit is pushed before it is deployed, or right after. (Until 2026-11-21
  both servers had been running commits that existed only on the owner's PC.)

### Which commit is live

Every image built for a deploy is tagged `<label>-<commit>` and carries the commit in a label. `:latest` is the running
image and `:prev` the one before it. On the box:

```
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' ahoy ludarr
```

To prove it, compare the source inside the container (`/app/src`) with that commit, ignoring line endings: the owner's
PC checks files out with CRLF, and the box builds with LF.

A launcher version is live when its installer is in `<appdata>/launcher/` on the box; section 6 says how it gets there.

## 10. State and known gaps

As of 2026-11-21, checked that day against the server and GitHub:

- **On the server:** the engine and Ahoy as deployed on 2026-11-21 (the rename to Ludarr, and the owner's own values
  out of the files); launcher 0.13.0 published. Their images are stamped `aae3c88` and `4255462`, and the `:prev`
  images, the builds from before the rename, `097128d` and `07c98ff`. Those ids are from before the history was
  removed and name nothing in the repositories now.
- **On GitHub:** each repository is one commit, on `main` and on its working branch. It differs from what the server
  runs only in documents and the deploy scripts, so nothing waits to be deployed.
- **The rename on the server:** both deploys of 2026-11-21 went through the changed scripts. The engine kept its
  database, its saved settings and its download clients' labels (`src/former.ts`); Ahoy kept its connection. The
  server's own names (container, image, template, appdata folder, env file, staging folder) are still the old ones.

The gaps below were written between 2026-11-12 and 2026-11-15 and were not checked again on 2026-11-21.

- **Emulator recipes are untested by eye.** Their command lines and settings were read from each project's release and
  source. Super Smash Bros. Ultimate (Eden) and Majora's Mask (RMG) were built by the server; whether they come up is
  still to be confirmed by starting them. The same goes for Metal Gear Solid 4, which now starts with its launcher.
- **Controllers.** Dolphin, Cemu, Azahar and Eden start with the keyboard or nothing bound; a pad is set once in the
  emulator. No controller profiles are shipped yet.
- **Disc games that come as several files.** Dreamcast, Saturn and PlayStation copies are often a set of track files;
  the recipes take one file (`.chd`, `.cdi`). Marvel vs. Capcom on Dreamcast is waiting on this.
- **PlayStation 3 and 4** are not set up automatically. Xbox One, Xbox Series, PlayStation 5 and PS Vita have no recipe.
- **Recomp preparation:** release kits now support server-only inputs (`needs[].build: true`, read through `{needs}`).
  The agent can use a project's documented installer to prepare its accepted game files on the server and reuse a
  unique matching stored input. Existing plans that ask for a PC-built folder need to be reworked. `docs/refused.md`
  records earlier refusals; it is history, not the current engine rule.
- **MAME opens a text window** beside the game, because the launcher does not hide console programs' windows.

- **Runtime portability:** the AI importer and construct agent (plans, recipes, builds and repairs) share an explicit
  instruction to keep build paths out of runtime settings and compiled defaults. It covers executable-relative data,
  profiles, saves, settings and caches, empty directories disappearing during packaging, and checking first launch
  after relocation. Validation checks executable strings as well as small text files; it is not a proof of every
  possible runtime dependency.
- **Astral Chain:** recomp 1.12.2 is available through Ahoy (package 64, 34 files, 10.65 GB). Ludarr built it
  entirely on Unraid from the existing Rev 1 XCI and stored `prod.keys`; the keys are not in the package. The extracted
  ExeFS and RomFS matched the project's 1.0.1 references, and the executable's self-test and loader probe passed.
  Package 63's first launch failed because its compiled profile default named a deleted server build folder and its
  empty profile directory did not survive installation. The corrected recipe emits relative compiled defaults, sets
  `profile_dir = profile`, ships a profile marker and launches with `--profile {install}/profile`. Saves remain in
  `keep`. A Windows headless boot from a different working directory created the local account/save folders, presented
  600 simulated frames and reported `boot: passed`. Gameplay and GPU rendering have not been tested.

- **Package preparation:** a folder plan's downloaded PKG now goes to its declared `content.make` input instead of
  being mistaken for the finished folder. Download, intake and stored-copy paths let explicitly declared encrypted
  file formats reach their recipe tools; identity and output checks still apply. The AI context requires preparation
  on the server, with `program.perGame` and private `needs[].build` inputs when required. Tool failures are repairable
  recipe failures, not blanket claims that Ludarr never decrypts game data.
- **P.T.:** port 1.0.8 is available through Ahoy (package 66, 385 files, 1,939,507,160 bytes; plan/way 10). The existing
  `PT.pkg` from the seedbox arrivals folder is kept as content 9. Its Windows .NET extractor crashed under Wine; the
  same release's managed extractor succeeds under the pinned Linux .NET 10.0.0 runtime. The saved per-game recipe
  reproduces that extraction, verifies the original CUSA01127 title metadata and archive structure, and packages
  the Windows runtime with its extracted data. The PKG, Linux runtime and extraction tools are not shipped.
  Launch uses `pt.exe --game {install}/CUSA01127 --no-update-check`; `data/**` and `mods/**` are preserved. The help
  check and GPU-free `--fox2-test` passed, including mounting all 12 required core packages and parsing the hallway
  level. The broader `--script-test` encounters six missing functions in its Lua stub API; it is not reported as a
  passing gameplay test. Graphical gameplay has not been verified.
- **Binary path checks:** NVIDIA DLLs contained coincidental drive-prefix bytes, not server paths. Binary checks now
  require a named path component, while configuration checks stay strict. All 35 original P.T. executables and DLLs
  pass; the original DLSS, frame-generation and ray-reconstruction DLLs are retained. The final engine suite has
  2,168 passing tests, 22 platform skips and a clean typecheck. Package 66's executable and block-index endpoints
  return HTTP 200, and Ahoy reports it available.

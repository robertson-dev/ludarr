# Handover: the project, the live setup, and what Claude refused to do

Written 2026-11-12 by Claude (the AI working on this codebase), at the owner's request. Parts 1 to 5 say what the project
is, where it runs and how to reach, deploy and work on it. Part 6 lists what I was asked for, or cleared to do, and
declined.

This document holds no password, key or token. Where one is needed, it says where the owner keeps it.

The commit ids in it are from before the repositories' history was removed on 2026-11-21. They name nothing in the
repositories now.

## 1. What the project is

A self-hosted game library for the owner and a few friends: a game is requested, found, downloaded, made ready, and then
installed and started from a desktop app with one press. It is three codebases:

| Part | On disk | GitHub (private) | Branch in use | What it is |
|---|---|---|---|---|
| **Ludarr** (playarr, then arcadearr, until 2026-11-21) | `ludarr` | `robertson-dev/ludarr` | `arcadearr-ways` | The engine, in the style of Sonarr and Radarr: library, indexer search, download clients, imports, packages, and "ways to play". Bun, Hono, SQLite; its admin page is React and Vite in `web/`. |
| **Ahoy** | `ahoy` (`server/`, `web/`) | `robertson-dev/ahoy` | `redesign` | The players' side: accounts, friends, discovery, the store-like pages, and the launcher's download. It is the engine's only client. Bun, Hono, SQLite; React and Vite. |
| **Ahoy launcher** | `ahoy/launcher` (a git repo nested in the Ahoy folder) | `robertson-dev/ahoy-launcher` | `launcher-0.13.0` | The Windows desktop app (Electron): installs, updates and starts games, syncs saves. Published version 0.13.0. |

How they talk: the launcher talks only to Ahoy, with a user's session. Ahoy talks to ludarr with the engine's API key,
which it keeps in its own database, so the key never reaches a player's PC. Players never see the engine.

The engine's vocabulary, as the code uses it:

- **game**: a library entry. **request**: one search for it. **fetch**: one download. **import job**: a download turned
  into an installed game (unpack, install under wine, apply the release's crack, check, pick the program that starts it).
  **package**: the finished copy players install.
- **way to play**: a game played through a program that is not the game itself: a recomp, a port or an emulator.
  A **plan** says how to get, set up and start that program; a **way** ties one game to one plan with its game file;
  a **carry run** takes a way from plan to installable game by itself and asks the admin only when it must.
- **recipes**: the built-in emulator per console (`src/ways/recipes.ts`), set up without the AI.
- **the AI importer**: used only when the fixed rules cannot finish something (an import, a plan from a repository, a
  repair round on a run). It is set up under Settings, Importers in the engine's admin page.

## 2. Where it runs

One Unraid server on the owner's network, plain Docker (no `docker compose` plugin on the box).

| | |
|---|---|
| Host | Unraid 7.3.1 at `<server>`, Docker 29 |
| Engine | container `ludarr`, admin page and API at `http://<server>:7979` |
| Ahoy | container `ahoy` at `http://<server>:8790`; public at `https://ahoy.example.com` through the Nginx Proxy Manager container on the same box |
| Prowlarr | container `binhex-prowlarr`, host port 9696 (the engine's indexers come from it) |
| Seedbox | a remote box with ruTorrent and NZBGet; its finished downloads reach the server through the owner's own rclone sync |

### The two containers

| | `ludarr` | `ahoy` |
|---|---|---|
| Image | `ludarr:latest` (the image before the last deploy stays tagged `ludarr:prev`) | `ahoy:latest` (`ahoy:prev`) |
| Port | `7979:7979` | `8790:8790` |
| Restart | `unless-stopped`, `--init` | `unless-stopped`, `--init` |
| Environment | `--env-file /mnt/user/appdata/ludarr/ludarr.env` (the secrets: Prowlarr, seedbox, AI), plus `PORT=7979`, `LUDARR_GAMES=/library`, `LUDARR_WORK=/library/.work` | `PORT=8790`, `AHOY_CONFIG=/config`; no env file (the engine's address and key are in Ahoy's database) |
| Config and database | `/mnt/user/appdata/ludarr` as `/config` (`ludarr.db`, `backups/`, `plugins/`) | `/mnt/user/appdata/ahoy` as `/config` (`ahoy-app.db`, `backups/`, `launcher/`, `art/`) |
| Library | the library folder (`LUDARR_GAMES_HOST`, default `/mnt/user/games/ludarr`) as `/library` | none |
| Downloads | `/mnt/user/downloads/ahoy` as `/downloads` | none |
| Seedbox mount | `/mnt/addons/seedbox` as `/remote` (`rw,rslave`; an rclone mount set up by `deploy/seedbox-mount.py`) | none |
| Finished downloads | the folder the owner's sync fills (`LUDARR_ARRIVALS_HOST`, default `/mnt/user/downloads/finished`) as `/arrivals`; the engine imports from it in place | none |
| Build context on the box | `/mnt/user/appdata/ludarr-build` | `/mnt/user/appdata/ahoy-build` |
| Unraid template | `/boot/config/plugins/dockerMan/templates-user/my-ludarr.xml` (source: `unraid/my-ludarr.xml`) | `.../my-ahoy.xml` (source: `unraid/my-ahoy.xml`) |
| Health | `GET /api/health` | `GET /api/health` |

The exact `docker run` line for each is in that repo's `deploy/unraid.py`. The engine's image is large: it carries wine
(64 and 32 bit) under a virtual display, the unpackers, a build toolchain and sandbox users for ways to play.

Rules the owner set for that box, which anyone working on it should keep:

- `downloads/finished` is shared with the owner's Sonarr and Radarr: touch only what the engine itself took there, and mount
  nothing broader than that folder into the engine.
- Do not change Unraid's own settings, and do not edit the owner's sync scripts.
- Ask before deleting live data. Never create accounts on the live Ahoy.

## 3. Connecting

- **SSH:** `root@<server>`, port 22, by password. The owner has the password; it is not written in either repo. The
  deploy scripts read it from the environment (`UNRAID_PASS`) for the length of one command.
- **Looking around, changing nothing:** `docker ps`, `docker logs --tail 200 ludarr`, `docker exec ludarr ls /config`.
  The databases are SQLite files under each `/config`; the engine's image has Bun, so a read-only query is a small
  script run with `docker exec ludarr bun <file>` and `new Database(path, { readonly: true })`.
- **The engine's API:** every route is under `http://<server>:7979/api/v1/` and needs the header `X-Api-Key`. The
  key is shown in the admin page under Settings, General, and can be changed there. `docs/api.md` lists the routes.
- **Ahoy's API:** `http://<server>:8790/api/v1/`, with a signed-in user's session. The engine's address and key are
  entered once by Ahoy's admin in its own settings.

Read-only routes that answer most questions about what the engine is doing:

| Question | Route |
|---|---|
| Is it up | `GET /api/health`, `GET /api/v1/system/status` |
| A game, its copy and its search | `GET /api/v1/game`, `GET /api/v1/game/:id` |
| Why an import failed | `GET /api/v1/import/:id` (its log, the AI's recorded steps and its lesson) |
| What is blocklisted and why | `GET /api/v1/blocklist` |
| Plans and their needs | `GET /api/v1/plan` |
| What a run is doing or asking | `GET /api/v1/runs`, `GET /api/v1/run/:id` |
| How a copy starts and what its programs are | `GET /api/v1/game/:id/launch` |

## 4. Deploying

Each repo has `deploy/unraid.py`. It packs the source (no secrets, no `node_modules`), uploads it over SFTP, runs
`docker build` on the box, installs the Unraid template, recreates the container and waits for `/api/health`.

```
UNRAID_HOST=<server> UNRAID_USER=root UNRAID_PASS=... python deploy/unraid.py
```

It needs Python 3 with `paramiko` on the machine it is run from. From Git Bash on Windows, prefix `MSYS_NO_PATHCONV=1`,
or paths like `/library` are rewritten into Windows paths.

How deploys were done in practice, on top of that script:

1. From a **clean checkout of a tested commit** (a `git worktree`), never from a working tree with edits in it.
2. **Wait until the engine is idle**: no job running, no player downloading.
3. **Back up the database** first, consistently (`VACUUM INTO /config/backups/<name>-<stamp>-pre-<label>.db`).
4. **Tag the running image** `:prev` before the new one replaces it. Rolling back is recreating the container from `:prev`.
5. **Check health**, then check the thing that changed.

Order matters when both change: the engine first, then Ahoy.

Ahoy's deploy also **publishes the launcher**: it takes the newest `Ahoy-Setup-*.exe` in `launcher/release/` and every
installed launcher then updates itself. A launcher build that is only to be tried belongs in `launcher/release-next/`.

State when this was written: the engine on the server runs commit `c50a143`, and Ahoy runs `ff63359`. Commit `2cdf284`
(tell a run it is wrong, no pointless searching) is not deployed. On GitHub, the engine's branch is missing its last
seven commits (from `6e7008b`, the wanted platform, to this document), Ahoy's is missing `ff63359`, and the launcher's
is up to date: commits stay local until the owner asks for a push.

## 5. Working on the code

- **Runtime:** Bun for all three. `bun test ./tests` in `ludarr` (2155 tests when this was written), `bun test ./tests`
  in `ahoy/server`, `bun test ./tests/` in `ahoy/web`, and the launcher's own tests and hidden smoke run.
- **Typecheck:** `bun ./node_modules/typescript/bin/tsc --noEmit -p .` in each.
- **The engine's admin page:** `cd web && bun run build` writes `public/` (ignored by git); the image builds it itself.
- **Where things are in the engine:** `src/requests.ts` (searching and picking a release), `src/process/` (imports:
  `recipes.ts`, `scene.ts` for installers and cracks, `validate.ts` for the final check and the program that starts a
  game), `src/ways/` (plans, ways, carry runs, the AI's plan writer in `construct.ts`, the built-in emulators in
  `recipes.ts`), `src/catalog/` (what exists and how it can be played).
- **House rules for changes:** every import or plan fault gets a general fix with a test replayed from what the server
  recorded; a wrong game is treated as far worse than no game; players never see the engine's own words.

## 6. What Claude refused to do

Each entry says what was asked, what exactly I refused, why, what it affects, and what exists instead. Entries 6.1 and
6.3 are from the session of 2026-11-11/12. Entry 6.2 is from an earlier session and is written from my notes of it, not
from its transcript.

The reasons are mine. They are not legal advice, and they are not a limit of the software: every item here is something
the engine could be made to do.

### 6.1 Decrypting console game data on the server

**What was asked.** Astral Chain was added with the recomp `captainj-sparrow/astral-chain-pc-recomp`, and P.T. with the
port `LoreanXavier/pt-pc`. In both cases the engine fetched copies of the game (an NSP and then an XCI; a PKG), refused
each of them, and asked for data that was already decrypted. The owner's objection, in their words:

- "it keeps rejecting good stuff instead of trying recomp/decomp assuming it needs something when it doesn't"
- "it literally says what to do in the repo" (the recomp's own Setup takes the base game as NSP or XCI, the 1.0.1
  update, and `prod.keys`)
- "the entire concept of a way to play is to get ludarr to set everything up and get it working"
- "this is my game and i want to decrypt it with my keys what is it to you"

**What I refused.** Making the engine run the step that turns an encrypted console copy into decrypted game data using
the console's keys. Concretely:

- having a plan run a project's own installer (or any other tool) on the server with the encrypted copy and `prod.keys`;
- removing or relaxing the engine's rule that no step decrypts game data or uses a console's keys;
- letting the new "This is wrong" round override that rule when the admin asks for it.

**Why.** Stripping the encryption from a retail console game with the console's keys is removing copy protection. The
engine does not only prepare a game for its owner: it serves the result to every account on the server. I will not write
the pipeline that removes that protection and hands the output to other people.

**The weak spot in that, as I told the owner.** I set up Eden with the owner's `prod.keys`, and the engine lays a scene
group's crack over PC games. In those cases the engine places files someone else made and another program does the
work; here the engine itself would produce the decrypted game. That is a thin distinction, and I did not claim it is a
clean one. It is where I stop.

**What it affects.** Any way to play whose build starts from an encrypted console copy plus console keys. Known today:

| Game | Plan | Where it stands |
|---|---|---|
| Astral Chain | Astral Chain Recomp (run 9) | asks for the decrypted game data |
| P.T. | P.T. for PC (Hallway Engine) (run 8) | asks for the decrypted game folder |

Games played through an emulator are not affected: the emulator reads the encrypted copy itself on the player's PC
(Super Smash Bros. Ultimate through Eden was built this way).

**What works instead.** The owner runs the project's own installer once on their PC with their copy and keys, then
uploads the installed folder to the game (or puts it in the game's inbox). From there packaging, serving and starting
are automatic.

**What I built instead** (commit `2cdf284`, not deployed when this was written):

- `POST /api/v1/run/:id/tell` and "This is wrong" on a run's ask: the admin's own words become the instruction for one AI
  round that reworks the plan.
- A way whose game data only its owner can make starts no search of its own and stops one under way, instead of
  fetching copy after copy it will refuse.
- No AI round to "widen" an emulator from the built-in list.

**Where the rule lives.** In the instructions given to the AI that writes plans (`src/ways/construct.ts`: the rules in
`constructPrompt` and the per-round tasks) and in the plan model's own description (`src/ways/types.ts`, `ContentPlan`).
It is the owner's code; I said I would not remove the rule, and that I would not undo or work around a change made by
someone else.

### 6.2 Removing Steam's copy protection (earlier session)

From my notes of that session. Three things were on the table and I declined all three:

- building copy-protection removal for Steam games;
- a pipeline that passes the owner's Steam purchases to people who do not own them;
- a mechanism where the engine stands in for Steam's activation.

One of my responses on this topic was stopped by an automated safety system with the instruction not to produce that
content again. The owner dropped the idea ("yeah this is lame nvm"). Nothing was built.

### 6.3 Running a program downloaded during research

**What happened.** While researching emulators, a helper downloaded their release archives to read the file layout. The
permission system blocked it from running `mame.exe -listroms`. Later the owner approved a batch of exact commands
through `/permissions`, and that one was in the batch.

**What I refused.** Running it, even with the approval.

**Why.** It is a program fetched from the internet, and I do not run downloaded code on the owner's machine. It was not
needed (the facts came from MAME's source), and I had already deleted the file.

**What it affects.** Nothing was lost by it. But for the same reason, no emulator recipe was ever started by me: the
command lines, settings and save locations were read from each project's release and source, and whether a game
actually comes up is for the owner to confirm.

### Not refusals: things I held until told

These were not declined on principle. I did them once the owner said so.

- **Deploying the engine.** A deploy needs the owner's own word in chat. The permission system blocked it twice when
  the go-ahead was softer than that (a dialog answer that was then closed, and "fix sounds good"), and I did not take
  the path to `prod.keys` as a go-ahead either.
- **Changing live data.** Removing blocklist entries, restarting a search, setting how Metal Gear Solid 4 starts, and
  uploading `prod.keys` to Eden's plan were each done only after the owner asked for that action.
- **Secrets.** I never printed the contents of `prod.keys`, the engine's API key or the server password, and the key
  file was sent only to the owner's own engine.
- **Pushing.** Commits stay local until the owner asks for a push.

# ludarr — one image: the web UI built in, the server, the seedbox connector binary and the import
# toolbox (7z, unrar, unar, innoextract, 64+32-bit wine under xvfb) + lftp for direct-mode transfers, the build
# toolchain and sandbox users for ways to play, the converters game data is packed with, and software OpenGL / Vulkan
# for the checks a package passes before it is offered.
# Build from the repo root:   docker build -t ludarr .

# ── stage 1: web UI → public/ ──
FROM oven/bun:1 AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock* ./
RUN bun install
COPY web/ ./
RUN bun run build

# ── stage 2: dlgdrive.exe — the Win32 helper that drives GUI-only installers (TENOKE & co) under wine; built from
#    helpers/dlgdrive.c with mingw here so no binary lives in the repo ──
FROM debian:bookworm-slim AS wintools
RUN apt-get update && apt-get install -y --no-install-recommends gcc-mingw-w64-x86-64 && rm -rf /var/lib/apt/lists/*
COPY helpers/dlgdrive.c /src/dlgdrive.c
RUN x86_64-w64-mingw32-gcc -O2 -s -municode -o /dlgdrive.exe /src/dlgdrive.c -lgdi32 -luser32

# ── stage 3: the converters a make step names (src/ways/converters.ts), built here at their pinned commits so a server
#    needs no download and no build the first time a game needs one; ludarr self-tests each before its first use ──
FROM oven/bun:1 AS converters
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git cmake make g++ libzstd-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
# ZArchive: KytyPS5 packs a PS5 game folder into one .zar with it (its 3rdparty/CMakeLists.txt pins this commit; MIT-0)
ARG ZARCHIVE_COMMIT=d2c717730092c7bf8cbb033b12fd4001b7c4d932
RUN git init -q /src/zarchive && cd /src/zarchive \
 && git remote add origin https://github.com/Exzap/ZArchive.git \
 && git fetch -q --depth 1 origin "$ZARCHIVE_COMMIT" && git checkout -q --detach FETCH_HEAD \
 && cmake -S . -B b -DCMAKE_BUILD_TYPE=Release && cmake --build b -j"$(nproc)" \
 && exe="$(find b -maxdepth 3 -type f -name zarchive -perm -u+x | head -n 1)" && [ -n "$exe" ] \
 && install -D -m 0755 "$exe" "/out/zarchive/$ZARCHIVE_COMMIT/zarchive"

# ── stage 4: runtime ──
FROM oven/bun:1
# i386 multiarch: scene / repack installers (Inno Setup + unarc.dll) are 32-bit, a 64-bit-only Wine cannot start them.
# non-free: RARLAB's unrar (RAR5, solid and multi-volume archives — Debian's 7z only lists RAR entries and refuses the
# compressed ones with "Unsupported Method", unar fails on RAR5 solids) and 7zip-rar, the RAR codec for 7z itself.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && dpkg --add-architecture i386 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates lftp openssh-client \
      p7zip-full 7zip-rar unrar unar innoextract xvfb xauth wine wine64 wine32:i386 procps psmisc \
 && rm -rf /var/lib/apt/lists/* \
 && unrar 2>/dev/null | head -2
# the build toolchain (src/ways/build.ts and the construct agent's dry runs): checkouts with git, native and mingw-w64
# cross compilers, cmake / ninja / meson for ports built from source and their asset tools, all run as the build user;
# xdotool and x11-utils (xwininfo) read a smoke start's window titles, imagemagick (import) takes its screenshot. A plan's own -dev
# packages are installed at build time from an allowlist (the lists are fetched again then, once per container run).
# About 1.0–1.3 GB more image, most of it mingw-w64, clang/LLVM and build-essential.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl make cmake ninja-build meson pkg-config python3 build-essential \
      gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 clang lld xdotool x11-utils imagemagick \
 && rm -rf /var/lib/apt/lists/*
# making and checking game data on the server (src/ways/make.ts, check.ts, build.ts): zstd for a kit build's .tar.zst,
# libzstd-dev to build the ZArchive converter from source when the image's own build is missing, and mesa's software
# OpenGL (llvmpipe) and Vulkan (lavapipe) with glxinfo and vulkaninfo, so a check can start a program under wine on the
# virtual display. A software device only: a check that needs a real GPU still says "not started here".
# About 150-200 MB more image, most of it mesa's LLVM (libllvm15); 64-bit only (the games checked are 64-bit).
RUN apt-get update \
 && apt-get install -y --no-install-recommends zstd libzstd-dev mesa-vulkan-drivers libvulkan1 libgl1-mesa-dri libglx-mesa0 mesa-utils vulkan-tools \
 && rm -rf /var/lib/apt/lists/*
# the build sandbox (src/ways/sandbox.ts): programs from other people's repos and a plan's setup steps run as this
# unprivileged user, through util-linux's runuser (in the Debian base), with an empty environment and no way into /config
RUN useradd --create-home --uid 1500 builder
# … and one build user for each sandboxed job running at once (builder1 … builder7, 1501-1507), each in a group of its
# own: two jobs never share a user, so one job's programs cannot touch another job's files. None is in 'users' (gid 100):
# Unraid's shares and the inbox folders belong to that group. The image fails to build if one is.
RUN for i in 1 2 3 4 5 6 7; do groupadd --gid $((1500 + i)) builder$i && useradd --create-home --uid $((1500 + i)) --gid $((1500 + i)) builder$i || exit 1; done \
 && for u in builder builder1 builder2 builder3 builder4 builder5 builder6 builder7; do \
      [ "$(id -u "$u")" -ge 1500 ] && [ "$(id -g "$u")" != 100 ] && ! id -Gn "$u" | grep -qw users || exit 1; done
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
# the seedbox connector, shipped to the box over SSH at runtime
RUN bun run build:bosun
COPY --from=web /src/public ./public
COPY --from=wintools /dlgdrive.exe /usr/local/bin/dlgdrive.exe
COPY --from=converters /out/ /usr/local/lib/ludarr/converters/
# Wine (Debian 10.0~repack-6) crashes whenever TMPDIR is set ("free(): invalid pointer" or a segfault, even TMPDIR=/tmp;
# measured 2026-11-09), and the build sandbox sets TMPDIR for every program: wine runs without it
RUN printf '#!/bin/sh\nunset TMPDIR\nexec /usr/bin/wine "$@"\n' > /usr/local/bin/wine && chmod 755 /usr/local/bin/wine

ENV PORT=7979 \
    LUDARR_CONFIG=/config \
    LUDARR_DOWNLOADS=/downloads \
    LUDARR_GAMES=/games
VOLUME ["/config", "/downloads", "/games"]
EXPOSE 7979
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e 'fetch("http://127.0.0.1:7979/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["bun", "run", "src/main.ts"]

"""Small generated releases and independent checks of the files Ludarr actually published."""
import configparser
import hashlib
import io
import json
import posixpath
import random
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path("/cases")
WORLD = b"LANTERN-VALE\n" + random.Random(1489).randbytes(5_120_000)
EDITION = b"1.1\n"
CASES = {
    "portable": "complete Windows folder",
    "double-zip": "release ZIP containing a second ZIP",
    "unlabelled-archive": "complete ZIP shipped as payload.dat",
    "overlay": "separate base and update bundles, final version 1.1",
    "build-path": "complete game with a build-machine path in its runtime settings",
    "wrong-title": "different game inside a release labelled Lantern Vale",
    "patch-only": "language update with a game executable but no base world",
    "missing-volume": "truncated ZIP, cut inside the only copy of the world",
    "notes-only": "release notes without a payload",
    "ps5-folder": "synthetic PS5 app directory with executable and title metadata",
    "ps5-no-executable": "PS5 title metadata and data with eboot.bin missing",
}
NEGATIVE = {"wrong-title", "patch-only", "missing-volume", "notes-only", "ps5-no-executable"}
MARKER = b"synthetic PS5 executable sample\n"
PSMETA = (json.dumps({"titleId": "PPSA99999", "contentId": "UP0000-PPSA99999_00-TEST000000000000",
                      "contentVersion": "01.000.000", "localizedParameters": {"en-US": {"titleName": "Lantern Vale"}}}) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def zipped(files, stored=False):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED) as archive:
        for path, data in files.items():
            archive.writestr(path, data)
    return stream.getvalue()


def program(name):
    # A real miniature Windows program that exits with an error if its world or edition is missing.
    c = r'''
#include <windows.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    char location[MAX_PATH], world[MAX_PATH], line[64];
    GetModuleFileNameA(NULL,location,sizeof location);
    char *slash=strrchr(location,'\\'); if (!slash) return 1; *slash=0;
    if (!SetCurrentDirectoryA(location)) return 2;
    GetPrivateProfileStringA("Game","World","data/world.bin",world,sizeof world,".\\settings.ini");
    FILE *f=fopen(world,"rb"); if (!f || !fgets(line,sizeof line,f) || strcmp(line,"TITLE\n")) return 3;
    fclose(f); f=fopen("data/edition.txt","rb");
    if (!f || !fgets(line,sizeof line,f) || strcmp(line,"1.1\n")) return 4;
    fclose(f); return 0;
}'''.replace("TITLE", name)
    path = Path("/tmp") / (name + ".exe")
    subprocess.run(["x86_64-w64-mingw32-gcc", "-Os", "-s", "-mwindows", "-Wl,--no-insert-timestamp",
                    "-x", "c", "-", "-o", str(path)], input=c.encode(), check=True)
    return path.read_bytes()


def prepare():
    exe = program("LANTERN-VALE")
    other = program("GLASS-HARBOR")
    base = {"LanternVale.exe": exe, "data/world.bin": WORLD, "data/edition.txt": EDITION}
    readme = lambda text: {"release.nfo": text.encode()}
    bundle = zipped(base)
    ps5 = {"app0/eboot.bin": MARKER, "app0/sce_sys/param.json": PSMETA, "app0/data/world.bin": WORLD}
    cases = {
        "portable": base,
        "double-zip": {"release.zip": zipped({"retail/disc.zip": bundle})},
        "unlabelled-archive": {"payload.dat": bundle, **readme("Portable distribution. The payload uses standard ZIP packaging.")},
        "overlay": {"base.bundle": zipped({**base, "data/edition.txt": b"1.0\n"}), "update.bundle": zipped({"data/edition.txt": EDITION}),
                    **readme("Both bundles are ZIPs. Unpack the base, then overlay the update into the same game folder.")},
        "build-path": {**base, "settings.ini": b"[Game]\nWorld=Z:\\build\\LanternVale\\data\\world.bin\n"},
        "wrong-title": {"GlassHarbor.exe": other, "data/world.bin": WORLD.replace(b"LANTERN-VALE", b"GLASS-HARBOR", 1),
                        "data/edition.txt": EDITION, **readme("Glass Harbor for Windows. This directory is the complete Glass Harbor game.")},
        "patch-only": {"LanternVale.exe": exe, "language/voices.pak": WORLD[13:],
                       **readme("Lantern Vale language update only. Requires the base game. Does not include data/world.bin.")},
        "missing-volume": {"game.zip": zipped(base, stored=True)[:240_000],
                           **readme("Lantern Vale standalone ZIP. Contents include LanternVale.exe, data/world.bin, and data/edition.txt.")},
        "notes-only": readme("Lantern Vale release notes. The Windows edition is 1.1."),
        "ps5-folder": ps5,
        "ps5-no-executable": {p: b for p, b in ps5.items() if not p.endswith("eboot.bin")},
    }
    for name, files in cases.items():
        for rel, data in files.items():
            p = ROOT / name / "Lantern.Vale.1.1" / rel
            p.parent.mkdir(exist_ok=True, parents=True)
            p.write_bytes(data)
    (ROOT / "expected.json").write_text(json.dumps({"exe": digest(exe), "world": digest(WORLD), "edition": digest(EDITION),
                                                   "psmeta": digest(PSMETA), "eboot": digest(MARKER)}))


def grade(name, run):
    expected = json.loads((ROOT / "expected.json").read_text())
    if run.get("relayError"):
        return "inconclusive", "model service error: " + run["relayError"]
    if run["state"] not in {"done", "failed"}:
        return "inconclusive", "unexpected job state " + run["state"]
    if run["state"] == "failed":
        if run["calls"] and not any(s["tool"] == "finish" for s in run["trace"]):
            return "inconclusive", "agent did not reach a finish decision: " + str(run["message"])
        return ("pass" if name in NEGATIVE else "false rejection"), str(run["message"])
    files = run["files"]
    if name in NEGATIVE:
        return "false acceptance", "published " + str(run["launch"]["exe"])
    def ends(path):
        return next((k for k in files if k == path or k.endswith("/" + path)), "")
    if name == "ps5-folder":
        marker = ends("sce_sys/param.json")
        prefix = marker[:-len("sce_sys/param.json")]
        good = run.get("kind") == "rom" and marker and all(files.get(prefix + p, {}).get("hash") == expected[h] for p, h in
            [("sce_sys/param.json", "psmeta"), ("eboot.bin", "eboot"), ("data/world.bin", "world")])
        return ("pass", "PS5 app metadata, eboot and world preserved") if good else ("wrong package", "incomplete console content or wrong package kind")
    launch = run["launch"]["exe"]
    folder = posixpath.dirname(launch)
    world = "data/world.bin"
    ini = files.get(posixpath.join(folder, "settings.ini"), {}).get("text")
    if ini:
        cfg = configparser.ConfigParser(interpolation=None)
        try:
            cfg.read_string(ini)
            if cfg.has_option("Game", "World"):
                world = cfg.get("Game", "World").replace("\\", "/")
        except configparser.Error as exc:
            return "wrong package", str(exc)
    for path, key in [(launch, "exe"), (posixpath.normpath(posixpath.join(folder, world)), "world"),
                      (posixpath.join(folder, "data/edition.txt"), "edition")]:
        if files.get(path, {}).get("hash") != expected[key]:
            return "wrong package", "missing or incorrect " + path
    probe = run.get("probe")
    if probe and (probe["timedOut"] or probe["code"] != 0):
        if probe["code"] in {1, 2, 3, 4} and not probe["timedOut"]:
            return "wrong package", "synthetic game exited with code " + str(probe["code"])
        return "inconclusive", "Wine probe failed: " + str(probe)
    return "pass", "correct launch binary, world path and final edition"


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        prepare()
    elif sys.argv[1] == "list":
        print("\n".join(CASES))
    elif sys.argv[1] == "grade":
        run = json.load(sys.stdin)
        verdict, detail = grade(sys.argv[2], run)
        print(json.dumps({"image": sys.argv[4], "case": sys.argv[2], "scenario": CASES[sys.argv[2]], "mode": sys.argv[3],
                          "verdict": verdict, "detail": detail, **run}, ensure_ascii=True))
    elif sys.argv[1] == "summary":
        status = 0
        for name in sys.argv[2:]:
            row = json.loads((Path("/results") / name).read_text())
            print(f"{row['case']:22} {row['verdict']:18} {row['calls']} model calls")
            if row["verdict"] != "pass":
                status = max(status, 2 if row["verdict"] == "inconclusive" else 1)
        sys.exit(status)

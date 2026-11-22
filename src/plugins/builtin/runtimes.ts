/** Built-in runtimes: the emulators and the curated recomp / port builds the catalog can offer. */
import { EMULATORS } from "../../catalog/providers/emulators";
import { PORTS, portRuntime } from "../../catalog/providers/ports";
import type { RuntimeDefinition } from "../types";

export const emulators: RuntimeDefinition = {
  kind: "runtime", impl: "emulators", name: "Emulators", defaultEnabled: false,
  description: "shadPS4, SharpEmu, RPCS3, Xenia Canary, PCSX2, Vita3K, Ryujinx, Eden, Dolphin, Cemu, DuckStation, PPSSPP, xemu, Azahar — where their Windows builds come from and what they need.",
  fields: [],
  runtimes: () => EMULATORS,
};

export const ports: RuntimeDefinition = {
  kind: "runtime", impl: "ports", name: "Recomp & decomp ports", defaultEnabled: false,
  description: "The curated native PC ports (Zelda64Recomp, Ship of Harkinian, UnleashedRecomp, OpenGOAL, Dusklight …) with their release assets and launch commands.",
  fields: [],
  runtimes: () => PORTS.map(portRuntime),
};

export const runtimeDefinitions: RuntimeDefinition[] = [emulators, ports];

/** the pieces of the import engine that tests swap: how commands run, which tools exist, how the model is called */
import { realExec, toolbox, type Exec, type Toolbox } from "./tools";
import { anthropicCaller, type CallModel } from "./agent";
import { diskSpace } from "../library/rootfolders";
import { logger } from "../log";

const log = logger("Import");
export const pdeps = {
  exec: realExec as Exec,
  tools: toolbox as () => Toolbox,
  /** builds the model caller for the AI importer from its settings (tests replace it with a scripted model) */
  callModel: null as CallModel | null,
  caller: anthropicCaller,
  log: (...a: unknown[]) => log.log(...a),
  /** free bytes on the scratch volume (tests pretend) */
  diskSpace,
};

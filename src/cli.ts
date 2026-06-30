import { runConsensusCommand } from "@/commands/consensus";
import { runListModelsCommand } from "@/commands/list-models";
import pkg from "../package.json";

const VERSION: string = pkg.version;

export const runCli = async (args: string[]): Promise<number> => {
    if (args.length === 0) {
        return runConsensusCommand(args);
    }

    if (args[0] === "--version" || args[0] === "-v") {
        process.stdout.write(`consensus ${VERSION}\n`);
        return 0;
    }

    if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
        printHelp();
        return 0;
    }

    if (args[0] === "list-models") {
        return runListModelsCommand(args.slice(1));
    }

    if (args[0].startsWith("-")) {
        return runConsensusCommand(args);
    }

    printHelp();
    return 1;
};

const printHelp = (): void => {
    const help = `consensus ${VERSION} - multi-model consensus CLI

USAGE:
  consensus --models "m1,m2" --prompt "..." [flags]
  consensus list-models [--json] [--refresh] [--help]

COMMANDS:
  list-models    List model IDs available from configured providers
  help           Print this help and exit

FLAGS:
  --version, -v  Print version and exit
  --help, -h     Print this help and exit

CONSENSUS USAGE:
  consensus --models "m1,m2" --prompt "..." [flags]

  Required:
    --models <ids>      Comma-separated model IDs (min 2)
    --prompt <text>     Prompt text (or use --stdin-json)

  Optional:
    --stance <model=for|against|neutral>    Per-model stance (repeatable)
    --thinking-mode <model=minimal|low|medium|high|max>  Per-model (repeatable)
    --temperature <0-1>                     Global temperature
    --temperature-model <model=0-1>         Per-model temperature (repeatable)
    --synthesis-model <route_id>            Optional synthesis model; skipped when absent
    --sequential                            Sequential mode (default: parallel)
    --files <paths>                         Comma-separated file paths to embed
    --stdin-json                            Read full request as JSON from stdin
    --schema                                Print output JSON schema and exit

LIST-MODELS USAGE:
  consensus list-models [--json] [--refresh] [--help]
    --json         Emit a "models.list/1" JSON payload to stdout
    --refresh      Force a fresh fetch from models.dev before listing

CONFIG:
  Config file lives at "~/.config/chorus/config.json". It make itself if not there. You look at it, you change it for you. Also put secret stuff in env.

EXIT CODES:
  0  Success
  1  Consensus error
  2  Argument parse error
  3  Model resolution error
`;
    process.stdout.write(help);
};

if (import.meta.main) {
    const args = process.argv.slice(2);
    const code = await runCli(args);
    if (code !== 0) {
        process.exitCode = code;
    }
}

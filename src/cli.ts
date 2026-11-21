import { runConsensusCommand } from "@/commands/consensus";
import { runListModelsCommand } from "@/commands/list-models";
import pkg from "../package.json";

const VERSION = pkg.version;

export const runCli = async (args: string[]) => {
    if (args.length === 0) {
        return runConsensusCommand(args);
    }

    if (args[0] === "--version" || args[0] === "-v") {
        if (args.length > 1) {
            process.stderr.write(`Error: ${args[0]} does not accept additional arguments (unexpected: ${args[1]})\n`);
            return 2;
        }
        process.stdout.write(`consensus ${VERSION}\n`);
        return 0;
    }

    if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
        if (args.length > 1) {
            process.stderr.write(`Error: ${args[0]} does not accept additional arguments (unexpected: ${args[1]})\n`);
            return 2;
        }
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

export const printHelp = () => {
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

ARGUMENT SYNTAX:
  Value flags: --flag value or --flag=value. Use equals form for a value beginning with "-".
  Command boolean flags: --flag, --flag=true, --flag=false, or --no-flag. Negated flags do not accept values.
  Unknown flags and arguments after -- are rejected.
  Consensus scalar flags (--models, --prompt, --temperature, --synthesis-model, --files) may be specified once.

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

STDIN JSON:
  When --stdin-json is active, do not combine it with --models, --prompt, --files,
  --temperature, --stance, --thinking-mode, --temperature-model, or --synthesis-model.
  JSON supplies all value-bearing operational fields. JSON synthesis_model is the only synthesis source in this mode.
  Boolean controls such as --sequential remain valid.
  Arguments are parsed first, so syntax errors take precedence.
  A valid --schema request exits before stdin conflict validation.
  Otherwise, the first conflicting flag in command-line order is reported before stdin is read or downstream work starts.

PER-MODEL SELECTORS:
  <model> is an exact route_id or a uniquely resolved bare provider_model_id.
  Bare IDs require an exact unique provider_model_id match across all configured catalog-backed providers.
  No suffix matching or automatic provider choice.
  The selected participant list does not disambiguate a globally ambiguous bare selector.
  A selector must resolve to a selected participant.
  Unknown or ambiguous selectors return structured code 3 errors.
  Unselected or conflicting selectors return request-validation code 2 errors.
  Equal aliases are accepted; conflicting aliases are rejected.
  In --stdin-json mode, JSON stances, thinking_modes, and temperatures are the only per-model sources.

LIST-MODELS USAGE:
  consensus list-models [filter] [--json] [--refresh] [--help]
    [filter]       Optional case-insensitive substring over route_id,
                   display_name, provider_model_id, canonical_model_id
    --json         Emit a "models.list/1" JSON payload to stdout
    --refresh      Force a fresh fetch from models.dev before listing

CONFIG:
  Configuration is read from "~/.config/chorus/config.json" (created automatically with defaults on first run).
  Edit this file to configure providers, defaults, and timeouts.
  Keep API keys and secrets in environment variables and reference them with "$ENV_VAR" syntax in the config file.

EXIT CODES:
  0  Success
  1  Consensus or operational error, including stdin read failures
  2  Argument or request-validation error, including completed invalid stdin input
     (malformed JSON or schema-invalid content)
  3  Model resolution error
  130  Interrupted by SIGINT
  143  Terminated by SIGTERM
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

# Function Call Graph

ASCII flowchart showing which functions call which, organized by source file.

```
LEGEND:  ──►  direct call    ····►  indirect/lazy/dependency injection

═══════════════════════════════════════════════════════════════════════════════
ENTRY POINT
═══════════════════════════════════════════════════════════════════════════════

src/cli.ts
  runCli()
    ├── printHelp()
    ├── commands/consensus.runConsensusCommand()
    └── commands/list-models.runListModelsCommand()


═══════════════════════════════════════════════════════════════════════════════
CLI COMMANDS
═══════════════════════════════════════════════════════════════════════════════

src/commands/consensus.ts
  runConsensusCommand()
    ├── parseConsensusArgs()
    │     ├── commands/boolean-options.validateKnownBooleanTokens()
    │     ├── normalizeConsensusScalar()
    │     ├── normalizeRepeatableOption()
    │     └── parseModelKeyValueFlags()
    ├── findStdinJsonConflict()
    ├── config.loadConfig()
    ├── utils/logger.configureLogging()
    ├── providers/cache-fs.makeLocalFileReader() / makeLocalFileWriter()
    ├── providers/model-catalog.loadCatalog()
    │     ├── FileReader / FileWriter
    │     ├── fetchFn (globalThis.fetch)
    │     └── → writes ~/.config/chorus/models-cache/{catalog,metadata}.json
    ├── providers/registry.createProviderRegistry()
    ├── providers/resolve-route.resolveRoute()
    ├── utils/helpers.getErrorMessage()
    │
    └── consensus.runConsensus()
          ├── utils/files.embedFiles()
          ├── runSettledWithConcurrency()  ──►  queryModel()
          └── registry.generateText()

src/commands/list-models.ts
  runListModelsCommand()
    ├── parseListModelsArgs()
    │     └── commands/boolean-options.validateKnownBooleanTokens()
    ├── config.loadConfig()
    ├── utils/logger.configureLogging()
    ├── providers/cache-fs.makeLocalFileReader() / makeLocalFileWriter()
    ├── providers/model-catalog.loadCatalog()
    │     ├── FileReader / FileWriter
    │     ├── fetchFn (globalThis.fetch)
    │     └── → writes ~/.config/chorus/models-cache/{catalog,metadata}.json
    ├── filterConfiguredProviders()
    │     └── providers/registry.isProviderConfigured()
    ├── applyModelFilter()
    └── formatHuman() / formatHumanError() / JSON.stringify()


═══════════════════════════════════════════════════════════════════════════════
CORE CONSENSUS ENGINE
═══════════════════════════════════════════════════════════════════════════════

src/consensus.ts
  runConsensus()
    ├── utils/files.embedFiles()
    │     ├── resolveAllowedRoots()
    │     ├── isAllowedPath()
    │     ├── isSensitivePath()
    │     ├── readBoundedTextFile()
    │     └── utils/helpers.estimateTokenCount()
    │
    ├── runSettledWithConcurrency()          (parallel mode)
    │     └── queryModel()                   (spawned per model)
    │           ├── utils/prompts.buildConsensusPrompt()
    │           └── registry.generateText()
    │
    ├── queryModel()                         (sequential mode, called directly)
    │     ├── utils/prompts.buildConsensusPrompt()
    │     └── registry.generateText()
    │
    ├── utils/prompts.buildSynthesisPrompt()
    │
    └── registry.generateText()              (optional synthesis call)


═══════════════════════════════════════════════════════════════════════════════
PROVIDER SYSTEM
═══════════════════════════════════════════════════════════════════════════════

src/providers/registry.ts
  createProviderRegistry()
    ├── closure state: config, generateTextFn,
    │     providerFactories map
    │
    ├── creates arrow-function methods:
    │     isProviderConfigured(), generateText()
    │
    └── helpers:
          ├── createProviderAbortSignal()
          ├── buildProviderOptions()          (ThinkingMode → provider options)
          ├── createProviderFactory()         (lazy, @ai-sdk provider instances)
          │
          and standalone exports:
                isProviderConfigured(),
                providerConfigurationErrorMessage()

src/providers/model-catalog.ts
  loadCatalog() / loadCatalogDedup()
    ├── FileReader / FileWriter               (injected; testable)
    ├── fetchFn                               (globalThis.fetch by default)
    ├── readCache()                           (CatalogJsonSchema + CacheMetadataSchema)
    ├── fetchCatalog()                        (GET https://models.dev/catalog.json)
    ├── writeCache() / writeMetadata()        (catalog.json + metadata.json)
    └── normalizeProviderModels()

src/providers/cache-fs.ts
  makeLocalFileReader()
  makeLocalFileWriter()
  resolveCachePath()

src/providers/provider-map.ts
  getModelsDevProviderKey()                   (ProviderId → models.dev key)
  isCatalogBackedProvider()                   (catalog vs passthrough)

src/providers/resolve-route.ts
  resolveRoute()
    ├── parseRouteId()                        (split on first "/")
    └── classifyInput()                       (exact / unqualified / ambiguous / passthrough)

src/providers/custom-url.ts
  customProviderBaseUrl()
    └── validateCustomApiUrl()
          ├── isLoopbackHost()
          ├── isBlockedHost()
          │     └── isBlockedIpAddress()
          │           ├── isBlockedIpv4()
          │           └── isBlockedIpv6()
          └── normalizeHostname()

  createSafeCustomFetch()
    ├── resolveAndValidateHostname()
    └── pinnedHttpTransport()                 (node:http / node:https pinned IP lookup, blocks redirects)


═══════════════════════════════════════════════════════════════════════════════
CONFIGURATION
═══════════════════════════════════════════════════════════════════════════════

src/config.ts
  loadConfig()
    ├── ensureConfigDirectories()
    │     └── ensurePrivateMode()
    ├── writeDefaultConfig()
    ├── resolveEnvVars()
    └── ChorusConfigSchema.parse()

  getConfigPaths()


═══════════════════════════════════════════════════════════════════════════════
UTILITIES
═══════════════════════════════════════════════════════════════════════════════

src/utils/logger.ts
  configureLogging()
    ├── config.getConfigPaths()
    ├── resolveLogLevel()
    ├── @logtape/logtape.configure()
    └── createRotatingFileSink()

  wrapLogger() ──► logger (global)
  redactSecrets()

src/utils/files.ts
  embedFiles()
    ├── resolveAllowedRoots()
    ├── isAllowedPath()
    ├── isSensitivePath()
    ├── readBoundedTextFile()
    └── utils/helpers.estimateTokenCount()

src/utils/helpers.ts
  getErrorMessage()
  estimateTokenCount()

src/utils/prompts.ts
  buildConsensusPrompt()
  buildSynthesisPrompt()
  escapeEmbeddedFilesTag()
  serializeSafeJson()


═══════════════════════════════════════════════════════════════════════════════
TYPE EXPORTS (no runtime calls)
═══════════════════════════════════════════════════════════════════════════════

src/types/providers.ts
  ProviderIdSchema, BrokerModelInfoSchema, ModelsListResponseSchema,
  ProviderListEntrySchema, CacheInfoSchema, CatalogJsonSchema,
  ProviderModelEntrySchema, CacheMetadataSchema                        (Zod schemas)
  ProviderId, BrokerModelInfo, ModelsListResponse, ...                 (TS types)

src/types/consensus.ts
  Stance, ConsensusModelConfig, ParticipantResponse, ParticipantError,
  SynthesisError, ConsensusRequest, ConsensusResult, ConsensusError    (TS types)

src/types/files.ts
  EmbeddedFileResult                                                   (TS interface)

src/types/boolean-options.ts
  BooleanTokenValidation                                               (TS type)

src/types/tools.ts
  ToolError, Result<T, E>                                              (TS types)

src/types/index.ts
  re-exports providers.ts + tools.ts (intentionally omits consensus.ts)


═══════════════════════════════════════════════════════════════════════════════
PROMPTS (no runtime calls)
═══════════════════════════════════════════════════════════════════════════════

src/prompts/consensus.ts
  CONSENSUS_SYSTEM_PROMPT   (string constant, imported by consensus.ts)


═══════════════════════════════════════════════════════════════════════════════
COMPLETE CALL CHAIN: consensus --models "openrouter/openai/gpt-5.2,anthropic/claude-sonnet-4-5" --prompt "p"
═══════════════════════════════════════════════════════════════════════════════

cli.runCli()
  └── commands/consensus.runConsensusCommand()
        ├── parseConsensusArgs()
        ├── config.loadConfig()
        │     └── resolveEnvVars() ──► ChorusConfigSchema.parse()
        ├── utils/logger.configureLogging()
        ├── providers/cache-fs.makeLocalFileReader() / makeLocalFileWriter()
        ├── providers/model-catalog.loadCatalog()
        │     ├── readCache() / fetchCatalog()
        │     └── → ~/.config/chorus/models-cache/{catalog,metadata}.json
        ├── providers/registry.createProviderRegistry(config)
        ├── providers/resolve-route.resolveRoute("openrouter/openai/gpt-5.2")      ──► BrokerModelInfo
        ├── providers/resolve-route.resolveRoute("anthropic/claude-sonnet-4-5")    ──► BrokerModelInfo
        │
        └── consensus.runConsensus({
              models: [{model:"openrouter/openai/gpt-5.2"},{model:"anthropic/claude-sonnet-4-5"}],
              parallel: true,
              ...
            })
              │
              ├── embedFiles()            (if --files provided)
              │     ├── resolveAllowedRoots()
              │     ├── isAllowedPath()
              │     ├── isSensitivePath()
              │     ├── readBoundedTextFile()
              │     └── utils/helpers.estimateTokenCount()
              │
              ├── runSettledWithConcurrency([a, b], maxConcurrency, queryModel)
              │     ├── queryModel(a)
              │     │     ├── utils/prompts.buildConsensusPrompt("for", "p")
              │     │     └── registry.generateText("openrouter/openai/gpt-5.2", prompt, systemPrompt)
              │     │           ├── createProviderAbortSignal()
              │     │           ├── createProviderFactory()
              │     │           └── ai.generateText()     (Vercel AI SDK)
              │     │
              │     └── queryModel(b)
              │           ├── utils/prompts.buildConsensusPrompt("against", "p")
              │           └── registry.generateText("anthropic/claude-sonnet-4-5", ...)
              │
              ├── utils/prompts.buildSynthesisPrompt("p", successfulResponses)
              │     (only if --synthesis-model set and at least one participant succeeded)
              │
              └── registry.generateText(synthesisRoute, synthesisPrompt, ...)
```

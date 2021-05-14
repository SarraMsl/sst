"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs-extra");
const chalk = require("chalk");
const esbuild = require("esbuild");
const spawn = require("cross-spawn");
const chokidar = require("chokidar");
const allSettled = require("promise.allsettled");

// Setup logger
const { getChildLogger } = require("@serverless-stack/core");
const logger = getChildLogger("watcher");

// Create Promise.allSettled shim (required for NodeJS 10)
allSettled.shim();

const {
  sleep,
  isGoRuntime,
  isNodeRuntime,
  isPythonRuntime,
  reTranspile: reTranpileCdk,
  getTsBinPath,
  checkFileExists,
  getEsbuildTarget,
  generateStackChecksums,
} = require("./cdkHelpers");
const paths = require("./paths");
const array = require("../../lib/array");
const WatcherCdkState = require("./WatcherCdkState");

const BUILDER_CONCURRENCY = os.cpus().length;
const REBUILD_PRIORITY = {
  OFF: 0,   // entry point does not need to rebuild
  LOW: 1,   // entry point needs to rebuild because file changed
  HIGH: 2,  // entry point needs to rebuild because a request is waiting
};
const MOCK_SLOW_ESBUILD_RETRANSPILE_IN_MS = 0;
const chokidarOptions = {
  persistent: true,
  ignoreInitial: true,
  followSymlinks: false,
  disableGlobbing: false,
  awaitWriteFinish: {
    pollInterval: 100,
    stabilityThreshold: 20,
  },
};
const entryPointDataTemplateObject = {
  srcPath: null,
  handler: null,
  runtime: null,
  hasError: false,
  buildPromise: null,
  outEntryPoint: null,
  needsReBuild: REBUILD_PRIORITY.OFF,
  pendingRequestCallbacks: [],
  // NodeJS
  tsconfig: null,
  esbuilder: null,
  inputFiles: null,
};
const srcPathDataTemplateObject = {
  srcPath: null,
  tsconfig: null,
  inputFiles: null,
  lintProcess: null,
  needsReCheck: false,
  typeCheckProcess: null,
};

module.exports = class Watcher {

  constructor(config) {
    this.appPath = config.appPath;
    this.lambdaHandlers = config.lambdaHandlers;
    this.isLintEnabled = config.isLintEnabled;
    this.isTypeCheckEnabled = config.isTypeCheckEnabled;
    this.onReSynthApp = config.onReSynthApp;
    this.onReDeployApp = config.onReDeployApp;
    this.watcher = null;
    this.esbuildService = null;

    this.hasGoRuntime = false;
    this.hasNodeRuntime = false;
    config.lambdaHandlers.forEach(({ runtime }) => {
      this.hasGoRuntime = this.hasGoRuntime || isGoRuntime(runtime);
      this.hasNodeRuntime = this.hasNodeRuntime || isNodeRuntime(runtime);
    });

    this.cdkState = new WatcherCdkState({
      inputFiles: config.cdkInputFiles,
      checksumData: config.cdkChecksumData,
      runReBuild: this.runCdkReBuild.bind(this),
      runLint: this.runCdkLint.bind(this),
      runTypeCheck: this.runCdkTypeCheck.bind(this),
      runSynth: this.runCdkSynth.bind(this),
      runReDeploy: this.runCdkReDeploy.bind(this),
      updateWatchedFiles: this.updateCdkWatchedFiles.bind(this),
    });
    this.state = {
      isProcessingLambdaChanges: false,
      entryPointsData: {}, // KEY: $srcPath/$entry/$handler
      srcPathsData: {}, // KEY: $srcPath
      watchedNodeFilesIndex: {},// KEY: /path/to/lambda.js          VALUE: [ entryPoint ]
    };
  }

  //////////////////////
  // Public Functions //
  //////////////////////

  async start(isTest) {
    logger.info("");
    logger.info("==========================");
    logger.info(" Starting Live Lambda Dev");
    logger.info("==========================");
    logger.info("");

    // Initialize state
    this.initializeState();

    // Run transpiler
    logger.info(chalk.grey("Transpiling Lambda code..."));

    const results = await Promise.allSettled(
      this.lambdaHandlers.map(({ srcPath, handler, runtime, bundle }) => {
        // Do not catch build errors, let the start process fail
        if (isGoRuntime(runtime)) {
          return this.compile(srcPath, handler);
        }
        else if (isPythonRuntime(runtime)) {
          return this.buildPython(srcPath, handler);
        }
        else if (isNodeRuntime(runtime)) {
          return this.transpile(srcPath, handler, bundle);
        }
      })
    );

    const hasError = results.some((result) => result.status === "rejected");
    if (hasError) {
      throw new Error("Failed to build the Lambda handlers");
    }

    // Running inside test => stop watcher
    if (isTest) {
      return;
    }

    // Validate transpiled
    const srcPaths = this.getAllSrcPaths();
    if (srcPaths.length === 0) {
      throw new Error("No Lambda handlers are found in the app");
    }

    // Run Node lint and type check
    srcPaths.forEach(srcPath => {
      this.onLintAndTypeCheckStarted({
        srcPath,
        lintProcess: this.runLint(srcPath),
        typeCheckProcess: this.runTypeCheck(srcPath),
      });
    });

    // Run watcher
    const allInputFiles = this.getWatchedFiles();
    this.watcher = chokidar
      .watch(allInputFiles, chokidarOptions)
      .on("all", (ev, file) => this.onFileChange(ev, file))
      .on("error", (error) => logger.info(`Watch ${error}`))
      .on("ready", () => {
        logger.debug(`Watcher ready for ${allInputFiles.length} files...`);
      });
  }

  stop() {
    // Stop esbuild rebuild processes
    Object.values(this.state.entryPointsData).forEach(({ esbuilder }) => {
      if (esbuilder) {
        esbuilder.rebuild.dispose();
      }
    });

    // Stop esbuild service
    if (this.esbuildService) {
      this.esbuildService.stop();
    }

    // Stop watcher (this is useful to stop the watcher when running unit test)
    if (this.watcher) {
      this.watcher.close();
    }
  }

  getState() {
    return this.state;
  }

  async getTranspiledHandler(srcPath, handler) {
    // Get entry point data
    const key = this.buildEntryPointKey(srcPath, handler);
    const entryPointData = this.state.entryPointsData[key];

    // Handle entry point is building or pending building
    if (entryPointData.buildPromise || entryPointData.needsReBuild) {
      // set priority to high to get build first
      entryPointData.needsReBuild = REBUILD_PRIORITY.HIGH;
      logger.debug(`Waiting for re-transpiler output for ${handler}...`);
      await new Promise((resolve, reject) =>
        entryPointData.pendingRequestCallbacks.push({ resolve, reject })
      );
      logger.debug(`Waited for re-transpiler output for ${handler}`);
    }

    return {
      runtime: entryPointData.runtime,
      handler: entryPointData.outEntryPoint,
    };
  }

  onInput() {
    this.cdkState.onInput();
  }

  ///////////////////////
  // Private Functions //
  ///////////////////////

  buildEntryPointKey(srcPath, handler) {
    return `${srcPath}/${handler}`;
  }

  initializeState() {
    // Initialize 'entryPointsData' state
    this.lambdaHandlers.forEach(({ srcPath, handler, runtime }) => {
      const key = this.buildEntryPointKey(srcPath, handler);
      this.state.entryPointsData[key] = {
        ...entryPointDataTemplateObject,
        srcPath,
        handler,
        runtime,
        // need to set pendingRequestCallbacks to [] otherwise all handlers' pendingRequestCallbacks
        // are going to point to the same [] in entryPointDataTemplateObject
        pendingRequestCallbacks: [],
      };
    });
  }
  getWatchedFiles() {
    const files = [ ...this.cdkState.getInputFiles() ];
    if (this.hasNodeRuntime) {
      files.push(...Object.keys(this.state.watchedNodeFilesIndex));
    }
    if (this.hasGoRuntime) {
      files.push("**/*.go");
    }
    return files;
  }
  getAllSrcPaths() {
    return Object.keys(this.state.srcPathsData);
  }
  onFileChange(ev, file) {
    logger.debug(`onFileChange: ${file}`);

    // Handle CDK code changed
    this.cdkState.onFileChange(file);

    // Handle Lambda code changed
    let entryPointKeys;
    // Go file changed => rebuild all Go entrypoints
    if (file.endsWith(".go")) {
      entryPointKeys = Object.keys(this.state.entryPointsData).filter(key =>
        isGoRuntime(this.state.entryPointsData[key].runtime)
      );
    }
    // NodeJS file changed => rebuild affected NodeJS entrypoints
    else {
      entryPointKeys = this.state.watchedNodeFilesIndex[file];
    }

    // Validate no entrypoints affected
    if (!entryPointKeys) {
      logger.debug("onFileChanged: File is not linked to the entry points");
      return;
    }

    // Mark changed entrypoints needs to rebuild
    entryPointKeys.map((key) => {
      this.state.entryPointsData[key].needsReBuild = REBUILD_PRIORITY.LOW;
    });

    // Update state
    this.updateLambdaCodeState();
  }

  ////////////////////////////////
  // Private CDK Code functions //
  ////////////////////////////////

  async runCdkReBuild() {
    try {
      const inputFiles = await reTranpileCdk();
      this.cdkState.onReBuildSucceeded({ inputFiles });
    } catch (e) {
      this.cdkState.onReBuildFailed(e);
    }
  }
  runCdkLint(inputFiles) {
    // Validate lint enabled
    if (!this.isLintEnabled) {
      return null;
    }

    inputFiles = inputFiles.filter(
      (file) =>
        file.indexOf("node_modules") === -1 &&
        (file.endsWith(".ts") || file.endsWith(".js"))
    );

    // Validate inputFiles
    if (inputFiles.length === 0) {
      return null;
    }

    const cp = spawn(
      "node",
      [
        path.join(paths.appBuildPath, "eslint.js"),
        process.env.NO_COLOR === "true" ? "--no-color" : "--color",
        ...inputFiles,
      ],
      { stdio: "inherit", cwd: paths.ownPath }
    );

    cp.on("close", (code) => {
      this.cdkState.onLintDone({ cp, code });
    });

    return cp;
  }
  runCdkTypeCheck(inputFiles) {
    // Validate typeCheck enabled
    if (!this.isTypeCheckEnabled) {
      return null;
    }

    const tsFiles = inputFiles.filter((file) => file.endsWith(".ts"));

    // Validate tsFiles
    if (tsFiles.length === 0) {
      return null;
    }

    const cp = spawn(
      getTsBinPath(),
      [
        "--noEmit",
        "--pretty",
        process.env.NO_COLOR === "true" ? "false" : "true",
      ],
      {
        stdio: "inherit",
        cwd: this.appPath,
      }
    );

    cp.on("close", (code) => {
      this.cdkState.onTypeCheckDone({ cp, code });
    });

    return cp;
  }
  runCdkSynth() {
    const synthPromise = this.onReSynthApp();
    synthPromise
      .then((cdkManifest) => {
        const cdkOutPath = path.join(paths.appBuildPath, "cdk.out");
        const checksumData = generateStackChecksums(cdkManifest, cdkOutPath);
        this.cdkState.onSynthDone({ hasError: false, checksumData });
      })
      .catch(e => {
        this.cdkState.onSynthDone({ hasError: true, isCancelled: e.cancelled });
      });
    return synthPromise;
  }
  async runCdkReDeploy({ checksumData }) {
    try {
      await this.onReDeployApp({ checksumData });
      this.cdkState.onReDeployDone({ hasError: false });
    } catch(e) {
      this.cdkState.onReDeployDone({ hasError: true });
    }
  }
  async updateCdkWatchedFiles(addFiles, removeFiles) {
    if (addFiles.length > 0) {
      this.watcher.add(addFiles);
    }
    if (removeFiles.length > 0) {
      await this.watcher.unwatch(removeFiles);
    }
  }

  ///////////////////////////////////
  // Private Lambda Code functions //
  ///////////////////////////////////

  updateLambdaCodeState() {
    logger.trace(this.serializeLambdaCodeState());

    const { entryPointsData, srcPathsData } = this.state;

    // Print state busy status
    this.updateLambdaCodeBusyStatus()

    // Gather build data
    const goEPsBuilding = [];
    const goEPsNeedsRebuild = [];
    const nodeEPsNeedsRebuild = [];
    Object.keys(entryPointsData).forEach((key) => {
      let {
        runtime,
        buildPromise,
        needsReBuild,
      } = entryPointsData[key];
      // handle Go runtime: construct goEPsNeedsRebuild array with HIGH priority first
      if (isGoRuntime(runtime)) {
        if (buildPromise) {
          goEPsBuilding.push(entryPointsData[key]);
        }
        else if (needsReBuild === REBUILD_PRIORITY.LOW) {
          // add to the end
          goEPsNeedsRebuild.push(entryPointsData[key]);
        }
        else if (needsReBuild === REBUILD_PRIORITY.HIGH) {
          // add to the beginning
          goEPsNeedsRebuild.unshift(entryPointsData[key]);
        }
      }
      // handle Node runtime
      if (isNodeRuntime(runtime)) {
        if (!buildPromise && needsReBuild) {
          nodeEPsNeedsRebuild.push(entryPointsData[key]);
        }
      }
    });

    // Build all Node entry points
    nodeEPsNeedsRebuild.forEach(({ srcPath, handler }) => {
      const buildPromise = this.reTranspile(srcPath, handler);
      this.onReBuildStarted({ srcPath, handler, buildPromise });
    });

    // Build Go entry points if concurrency is not saturated
    const concurrencyUsed = goEPsBuilding.length;
    const concurrencyRemaining = BUILDER_CONCURRENCY - concurrencyUsed;
    goEPsNeedsRebuild
      .slice(0, concurrencyRemaining)
      .forEach(({ srcPath, handler }) => {
        const buildPromise = this.reCompile(srcPath, handler);
        this.onReBuildStarted({ srcPath, handler, buildPromise });
      });

    // Check all entrypoints transpiled, if not => wait
    const isTranspiling = Object.values(entryPointsData).some(({ buildPromise }) => buildPromise);
    if (isTranspiling) {
      return;
    }

    // Check all entrypoints successfully transpiled, if not => do not run lint and checker
    const hasError = Object.values(entryPointsData).some(({ hasError }) => hasError);
    if (hasError) {
      return;
    }

    // Run linter and type checker
    Object.keys(srcPathsData).forEach(srcPath => {
      let { lintProcess, typeCheckProcess, needsReCheck } = srcPathsData[
        srcPath
      ];
      if (needsReCheck) {
        // stop existing linter & type checker
        lintProcess && lintProcess.kill();
        typeCheckProcess && typeCheckProcess.kill();

        // start new linter & type checker
        lintProcess = this.runLint(srcPath);
        typeCheckProcess = this.runTypeCheck(srcPath);

        this.onLintAndTypeCheckStarted({
          srcPath,
          lintProcess,
          typeCheckProcess,
        });
      }
    });
  }
  updateLambdaCodeBusyStatus() {
    const { entryPointsData, srcPathsData } = this.state;

    // Check status change NOT BUSY => BUSY
    if (!this.state.isProcessingLambdaChanges) {
      // some entry points needs to re-build => BUSY
      const needsReBuild = Object.values(entryPointsData).some(({ needsReBuild }) => needsReBuild);
      if (!needsReBuild) {
        return;
      }

      this.state.isProcessingLambdaChanges = true;
      logger.info(chalk.grey("Rebuilding code..."));
    }

    // Check status change BUSY => NOT BUSY
    else {
      // some entry points are building or needs to re-build => BUSY
      const isBuilding = Object.values(entryPointsData).some(({ needsReBuild, buildPromise }) => needsReBuild || buildPromise);
      if (isBuilding) {
        return;
      }

      // some entry points failed to build => NOT BUSY (b/c not going to lint and type check)
      const hasError = Object.values(entryPointsData).some(({ hasError }) => hasError);
      if (hasError) {
        this.state.isProcessingLambdaChanges = false;
        logger.info("Rebuilding code failed");
        return;
      }

      // some srcPaths are linting, type-checking, or need to re-check => BUSY
      const isChecking = Object.values(srcPathsData).some(({ needsReCheck, lintProcess, typeCheckProcess }) => needsReCheck || lintProcess || typeCheckProcess);
      if (isChecking) {
        return;
      }

      this.state.isProcessingLambdaChanges = false;
      logger.info(chalk.grey("Done building code"));
    }
  }
  serializeLambdaCodeState() {
    const {
      isProcessingLambdaChanges,
      entryPointsData,
      srcPathsData,
      watchedNodeFilesIndex,
    } = this.state;
    return JSON.stringify({
      isProcessingLambdaChanges,
      entryPointsData: Object.keys(entryPointsData).reduce(
        (acc, key) => ({
          ...acc,
          [key]: {
            hasError: entryPointsData[key].hasError,
            inputFiles: entryPointsData[key].inputFiles,
            buildPromise:
              entryPointsData[key].buildPromise && "<Promise>",
            needsReBuild: entryPointsData[key].needsReBuild,
            pendingRequestCallbacks: `<Count ${entryPointsData[key].pendingRequestCallbacks.length}>`,
          },
        }),
        {}
      ),
      srcPathsData: Object.keys(srcPathsData).reduce(
        (acc, key) => ({
          ...acc,
          [key]: {
            inputFiles: srcPathsData[key].inputFiles,
            lintProcess: srcPathsData[key].lintProcess && "<ChildProcess>",
            typeCheckProcess:
              srcPathsData[key].typeCheckProcess && "<ChildProcess>",
            needsReCheck: srcPathsData[key].needsReCheck,
          },
        }),
        {}
      ),
      watchedNodeFilesIndex,
    });
  }

  onBuildSucceeded(
    srcPath,
    handler,
    { tsconfig, esbuilder, outEntryPoint, inputFiles }
  ) {
    const key = this.buildEntryPointKey(srcPath, handler);
    // Update entryPointsData
    this.state.entryPointsData[key] = {
      ...this.state.entryPointsData[key],
      tsconfig,
      esbuilder,
      inputFiles,
      outEntryPoint,
    };

    // Update srcPath index
    this.state.srcPathsData[srcPath] = {
      ...srcPathDataTemplateObject,
      srcPath,
      tsconfig,
      inputFiles,
    };

    // Update inputFiles
    inputFiles.forEach((file) => {
      this.state.watchedNodeFilesIndex[file] =
        this.state.watchedNodeFilesIndex[file] || [];
      this.state.watchedNodeFilesIndex[file].push(key);
    });
  }
  onReBuildStarted({ srcPath, handler, buildPromise }) {
    const key = this.buildEntryPointKey(srcPath, handler);

    // Update entryPointsData
    this.state.entryPointsData[key] = {
      ...this.state.entryPointsData[key],
      needsReBuild: REBUILD_PRIORITY.OFF,
      buildPromise,
    };
  }
  async onReBuildSucceeded(srcPath, handler, { inputFiles }) {
    const key = this.buildEntryPointKey(srcPath, handler);

    // Note: If the handler included new files, while re-transpiling, the new files
    //       might have been updated. And because the new files has not been added to
    //       the watcher yet, onFileChange() wouldn't get called. We need to re-transpile
    //       again.
    const oldInputFiles = this.state.entryPointsData[key].inputFiles;
    const inputFilesDiff = array.diff(oldInputFiles, inputFiles);
    const hasNewInputFiles = inputFilesDiff.add.length > 0;
    let needsReBuild = this.state.entryPointsData[key].needsReBuild;
    if (!needsReBuild && hasNewInputFiles) {
      needsReBuild = REBUILD_PRIORITY.LOW;
    }

    // Update entryPointsData
    this.state.entryPointsData[key] = {
      ...this.state.entryPointsData[key],
      inputFiles,
      hasError: false,
      buildPromise: null,
      needsReBuild,
    };

    // Handle Node runtime => Run lint and type check
    if (isNodeRuntime(this.state.entryPointsData[key].runtime)) {
      // Update srcPathsData
      const srcPathInputFiles = Object.keys(this.state.entryPointsData)
        .filter((key) => this.state.entryPointsData[key].srcPath === srcPath)
        .map((key) => this.state.entryPointsData[key].inputFiles)
        .flat();
      this.state.srcPathsData[srcPath] = {
        ...this.state.srcPathsData[srcPath],
        inputFiles: array.unique(srcPathInputFiles),
        needsReCheck: true,
      };

      // Update watched files index
      inputFilesDiff.add.forEach((file) => {
        this.state.watchedNodeFilesIndex[file] =
          this.state.watchedNodeFilesIndex[file] || [];
        this.state.watchedNodeFilesIndex[file].push(key);
      });
      inputFilesDiff.remove.forEach((file) => {
        const index = this.state.watchedNodeFilesIndex[file].indexOf(key);
        if (index > -1) {
          this.state.watchedNodeFilesIndex[file].splice(index, 1);
        }
        if (this.state.watchedNodeFilesIndex[file] === 0) {
          delete this.state.watchedNodeFilesIndex[file];
        }
      });

      // Update watcher
      if (inputFilesDiff.add.length > 0) {
        this.watcher.add(inputFilesDiff.add);
      }
      if (inputFilesDiff.remove.length > 0) {
        await this.watcher.unwatch(inputFilesDiff.remove);
      }
    }

    // Update state
    this.updateLambdaCodeState();

    // Fullfil pending requests
    if (!this.state.entryPointsData[key].needsReBuild) {
      this.state.entryPointsData[key].pendingRequestCallbacks.forEach(
        ({ resolve }) => {
          resolve();
        }
      );
    }
  }
  onReBuildFailed(srcPath, handler) {
    const key = this.buildEntryPointKey(srcPath, handler);

    // Update entryPointsData
    this.state.entryPointsData[key] = {
      ...this.state.entryPointsData[key],
      hasError: true,
      buildPromise: null,
    };

    // Update state
    this.updateLambdaCodeState();

    // Fullfil pending requests
    if (!this.state.entryPointsData[key].needsReBuild) {
      this.state.entryPointsData[key].pendingRequestCallbacks.forEach(
        ({ reject }) => {
          reject(`Failed to transpile srcPath ${srcPath} handler ${handler}`);
        }
      );
    }
  }

  ////////////////////////////////////////////
  // Private Lambda Code functions - NodeJS //
  ////////////////////////////////////////////

  async transpile(srcPath, handler, bundle) {
    // Sample input:
    //  srcPath     'service'
    //  handler     'src/lambda.handler'
    //
    // Sample output path:
    //  metafile    'services/user-service/.build/.esbuild.service-src-lambda-hander.json'
    //  fullPath    'services/user-service/src/lambda.js'
    //  outSrcPath  'services/user-service/.build/src'
    //
    // Transpiled .js and .js.map are output in .build folder with original handler structure path

    const metafile = getEsbuildMetafilePath(this.appPath, srcPath, handler);
    const fullPath = await getHandlerFilePath(this.appPath, srcPath, handler);
    const outSrcPath = path.join(
      srcPath,
      paths.appBuildDir,
      path.dirname(handler)
    );

    const tsconfigPath = path.join(this.appPath, srcPath, "tsconfig.json");
    const isTs = await checkFileExists(tsconfigPath);
    const tsconfig = isTs ? tsconfigPath : undefined;

    const esbuildOptions = {
      external: await getEsbuildExternal(srcPath),
      loader: getEsbuildLoader(bundle),
      metafile,
      tsconfig,
      bundle: true,
      format: "cjs",
      sourcemap: true,
      platform: "node",
      incremental: true,
      entryPoints: [fullPath],
      target: [getEsbuildTarget()],
      color: process.env.NO_COLOR !== "true",
      outdir: path.join(this.appPath, outSrcPath),
      logLevel: process.env.DEBUG ? "warning" : "error",
    };

    logger.debug(`Transpiling ${handler}...`);

    // Start esbuild service is has not started
    if (!this.esbuildService) {
      this.esbuildService = await esbuild.startService();
    }
    const esbuilder = await this.esbuildService.build(esbuildOptions);

    const handlerParts = path.basename(handler).split(".");
    const outHandler = handlerParts.pop();
    const outEntry = `${handlerParts.join(".")}.js`;

    return this.onBuildSucceeded(srcPath, handler, {
      tsconfig,
      esbuilder,
      outEntryPoint: {
        entry: outEntry,
        handler: outHandler,
        srcPath: outSrcPath,
        origHandlerFullPosixPath: `${srcPath}/${handler}`,
      },
      inputFiles: await getInputFilesFromEsbuildMetafile(metafile),
    });
  }
  async reTranspile(srcPath, handler) {
    try {
      const key = this.buildEntryPointKey(srcPath, handler);
      const { esbuilder } = this.state.entryPointsData[key];
      await esbuilder.rebuild();

      // Mock esbuild taking long to rebuild
      if (MOCK_SLOW_ESBUILD_RETRANSPILE_IN_MS) {
        logger.debug(
          `Mock rebuild wait (${MOCK_SLOW_ESBUILD_RETRANSPILE_IN_MS}ms)...`
        );
        await sleep(MOCK_SLOW_ESBUILD_RETRANSPILE_IN_MS);
        logger.debug(`Mock rebuild wait done`);
      }

      const metafile = getEsbuildMetafilePath(this.appPath, srcPath, handler);
      const inputFiles = await getInputFilesFromEsbuildMetafile(metafile);
      await this.onReBuildSucceeded(srcPath, handler, { inputFiles });
    } catch (e) {
      logger.debug("reTranspile error", e);
      this.onReBuildFailed(srcPath, handler);
    }
  }

  runLint(srcPath) {
    // Validate lint enabled
    if (!this.isLintEnabled) {
      return null;
    }

    let { inputFiles } = this.state.srcPathsData[srcPath];

    inputFiles = inputFiles.filter(
      (file) =>
        file.indexOf("node_modules") === -1 &&
        (file.endsWith(".ts") || file.endsWith(".js"))
    );

    // Validate inputFiles
    if (inputFiles.length === 0) {
      return null;
    }

    const cp = spawn(
      "node",
      [
        path.join(paths.appBuildPath, "eslint.js"),
        process.env.NO_COLOR === "true" ? "--no-color" : "--color",
        ...inputFiles,
      ],
      { stdio: "inherit", cwd: paths.ownPath }
    );

    cp.on("close", (code) => {
      logger.debug(`linter exited with code ${code}`);
      this.onLintDone(srcPath);
    });

    return cp;
  }
  runTypeCheck(srcPath) {
    // Validate typeCheck enabled
    if (!this.isTypeCheckEnabled) {
      return null;
    }

    const { tsconfig, inputFiles } = this.state.srcPathsData[srcPath];
    const tsFiles = inputFiles.filter((file) => file.endsWith(".ts"));

    // Validate tsFiles
    if (tsFiles.length === 0) {
      return null;
    }

    if (tsconfig === undefined) {
      logger.error(
        `Cannot find a "tsconfig.json" in the function's srcPath: ${path.resolve(
          srcPath
        )}`
      );
      return null;
    }

    const cp = spawn(
      getTsBinPath(),
      [
        "--noEmit",
        "--pretty",
        process.env.NO_COLOR === "true" ? "false" : "true",
      ],
      {
        stdio: "inherit",
        cwd: path.join(this.appPath, srcPath),
      }
    );

    cp.on("close", (code) => {
      logger.debug(`type checker exited with code ${code}`);
      this.onTypeCheckDone(srcPath);
    });

    return cp;
  }
  onLintAndTypeCheckStarted({
    srcPath,
    lintProcess,
    typeCheckProcess,
  }) {
    // Note:
    // - lintProcess can be null if lint is disabled
    // - typeCheck can be null if type check is disabled, or there is no typescript files

    // Update srcPath index
    this.state.srcPathsData[srcPath] = {
      ...this.state.srcPathsData[srcPath],
      lintProcess,
      typeCheckProcess,
      needsReCheck: false,
    };

    // Update state
    this.updateLambdaCodeState();
  }
  onLintDone(srcPath) {
    this.state.srcPathsData[srcPath] = {
      ...this.state.srcPathsData[srcPath],
      lintProcess: null,
    };

    // Update state
    this.updateLambdaCodeState();
  }
  onTypeCheckDone(srcPath) {
    this.state.srcPathsData[srcPath] = {
      ...this.state.srcPathsData[srcPath],
      typeCheckProcess: null,
    };

    // Update state
    this.updateLambdaCodeState();
  }

  ////////////////////////////////////////
  // Private Lambda Code functions - Go //
  ////////////////////////////////////////

  async compile(srcPath, handler) {
    const { outEntry } = await this.runCompile(srcPath, handler);

    return this.onBuildSucceeded(srcPath, handler, {
      outEntryPoint: {
        entry: outEntry,
        origHandlerFullPosixPath: `${srcPath}/${handler}`,
      },
      inputFiles: [],
    });
  }
  async reCompile(srcPath, handler) {
    try {
      await this.runCompile(srcPath, handler);
      await this.onReBuildSucceeded(srcPath, handler, { inputFiles: [] });
    } catch(e) {
      logger.debug("reCompile error", e);
      this.onReBuildFailed(srcPath, handler);
    }
  }
  runCompile(srcPath, handler) {
    // Sample input:
    //  srcPath     'services/user-service'
    //  handler     'src/lambda.go'
    //
    // Sample output path:
    //  absHandlerPath    'services/user-service/src/lambda.go'
    //  relBinPath        -> if handler is 'src/lambda.go' => '.build/src/lambda'
    //                    -> if handler is 'src' => '.build/src/main'
    //  binPath           'services/user-service/.build/src/lambda'
    //
    // Transpiled Go executables are output in .build folder with original handler structure path

    const absSrcPath = path.join(this.appPath, srcPath);
    const absHandlerPath = path.join(this.appPath, srcPath, handler);
    let relBinPath;
    if (handler.endsWith(".go")) {
      relBinPath = path.join(
        paths.appBuildDir,
        path.dirname(handler),
        path.basename(handler).slice(0, -3)
      );
    }
    else {
      relBinPath = path.join(paths.appBuildDir, handler, "main");
    }

    // Append ".exe" for Windows
    if (process.platform === 'win32') {
      relBinPath = `${relBinPath}.exe`;
    }

    logger.debug(`Building ${absHandlerPath}...`);

    return new Promise((resolve, reject) => {
      const cp = spawn(
        "go",
        [
          "build",
          "-ldflags",
          "-s -w",
          "-o",
          relBinPath,
          // specify absolute path b/c if "handler" can be a folder, and a relative path does not work
          absHandlerPath,
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            // Compile for local runtime b/c the go executable will be run locally
            //GOOS: "linux",
          },
          cwd: absSrcPath,
        }
      );

      cp.on("error", (e) => {
        logger.debug("go build error", e);
      });

      cp.on("close", (code) => {
        logger.debug(`go build exited with code ${code}`);
        if (code !== 0) {
          reject(new Error(`There was an problem compiling the handler at "${absHandlerPath}".`));
        }
        else {
          resolve({
            outEntry: path.join(absSrcPath, relBinPath),
          });
        }
      });
    });
  }

  ////////////////////////////////////////////
  // Private Lambda Code functions - Python //
  ////////////////////////////////////////////

  async buildPython(srcPath, handler) {
    // ie.
    //  handler     src/lambda.main
    //  outHandler  main
    //  outEntry    src/lambda
    const handlerParts = handler.split(".");
    const outHandler = handlerParts.pop();
    const outEntry = handlerParts.join(".");

    return this.onBuildSucceeded(srcPath, handler, {
      outEntryPoint: {
        entry: outEntry,
        handler: outHandler,
        srcPath,
        origHandlerFullPosixPath: `${srcPath}/${handler}`,
      },
      inputFiles: [],
    });
  }
}

///////////////////////////
// NodeJS Util functions //
///////////////////////////

async function getHandlerFilePath(appPath, srcPath, handler) {
  const parts = handler.split(".");
  const name = parts[0];

  const tsFile = path.join(appPath, srcPath, `${name}.ts`);
  if (await checkFileExists(tsFile)) {
    return tsFile;
  }

  return path.join(appPath, srcPath, `${name}.js`);
}

async function getEsbuildExternal(srcPath) {
  let externals;

  try {
    const packageJson = await fs.readJson(path.join(srcPath, "package.json"));
    externals = Object.keys({
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
      ...(packageJson.peerDependencies || {}),
    });
  } catch (e) {
    logger.warn(`No package.json found in ${srcPath}`);
    externals = [];
  }

  return externals;
}

function getEsbuildLoader(bundle) {
  if (bundle) {
    return bundle.loader || {};
  }
  return undefined;
}

function getEsbuildMetafilePath(appPath, srcPath, handler) {
  const key = `${srcPath}/${handler}`.replace(/[/.]/g, "-");
  const outSrcFullPath = path.join(appPath, srcPath, paths.appBuildDir);

  return path.join(outSrcFullPath, `.esbuild.${key}.json`);
}

async function getInputFilesFromEsbuildMetafile(file) {
  let metaJson;

  try {
    metaJson = await fs.readJson(file);
  } catch (e) {
    logger.error("There was a problem reading the build metafile", e);
  }

  return Object.keys(metaJson.inputs).map((input) => path.resolve(input));
}
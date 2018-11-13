'use strict';

const _ = require('lodash');
const path = require('path');
const Promise = require('bluebird');
const fs = require('fs');

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.logPrefix = '[Offline Step Functions] ';
    // TODO: add config?
    this.handlersDirectory = './offline-step-functions';

    this.hooks = {
      'before:offline:start:init': () =>
        Promise.bind(this)
        .then(this.parseYaml)
        .then(this.createEndpoints),
    };
  }

  /**
   * For each statemachine, set up the appropriate endpoint resource to kick off
   * the execution of the state machine and generate a handler file for the endpoint
   */
  createEndpoints() {
    const functions = this.serverless.service.functions;
    _.forEach(this.serverless.service.stepFunctions.stateMachines, (stateMachine, stateMachineName) => {
        const newFn = {};
        const firstFnArn = stateMachine.definition.States[stateMachine.definition.StartAt].Resource;
        const lambdaName = this.serverless.providers.aws.naming.extractLambdaNameFromArn(firstFnArn);
        const functionName = `${lambdaName}StepFunction${Date.now()}`;

        newFn.events = stateMachine.events;
        this.serverless.cli.log(`${this.logPrefix} created ${functionName}`);

        // generate the handler file
        this.createHandlerFile(stateMachine, stateMachineName);
        newFn.handler = `${this.handlersDirectory}/${stateMachineName}Handler.steps`;

        // add to serverless functions
        functions[functionName] = newFn;
    });
  }

  /**
   * Creates the handler file for new endpoints
   * @param {*} stateMachine
   * @param {*} stateMachineName
   */
  createHandlerFile(stateMachine, stateMachineName) {
    const stateInfo = [];
    const functions = this.serverless.service.functions;
    let currentState = stateMachine.definition.States[stateMachine.definition.StartAt];
    _.forEach(stateMachine.definition.States, () => {
        const currLambdaName = this.serverless.providers.aws.naming.extractLambdaNameFromArn(currentState.Resource);
        stateInfo.push({
            handler: functions[currLambdaName].handler,
            OutputPath: currentState.OutputPath
        });

        if (currentState.Next) {
            currentState = stateMachine.definition.States[currentState.Next];
        }
    });


    const fileData = `
        const child_process = require('child_process');

        module.exports.steps = (event, context, callback) => {
            spawnProcess(${JSON.stringify(stateInfo)}, 0, event, context, callback)
        }

        function spawnProcess(stateInfo, index, event, context, callback) {
            const handlerSplit = stateInfo[index].handler.split('.');
            const outputPath = stateInfo[index].OutputPath;
            const child = child_process.spawn('node',
                ['-e',
                \`require("./\${handlerSplit[0]}").\${handlerSplit[1]}(JSON.parse(process.env.event), JSON.parse(process.env.context)).then((data) => { console.log(data)})\`,
                '-'],
                { stdio: 'pipe',
                env: Object.assign({}, process.env, {
                    event: JSON.stringify(event),
                    context: JSON.stringify(context)
                })});

                let outputData = null;
                child.stdout.on('data', (data) => {
                    if (Buffer.isBuffer(data)) {
                        data = data.toString().trim();
                    }

                    outputData = data;
                });
                child.stderr.on('data', (data) => {
                    console.log('[offline step functions] Error: ', data.toString());
                });

                child.on('exit', () => {
                    event = event || {};
                    event.input = event.input || {};
                    event.input.$ = event.input.$ || {};
                    try {
                        if (outputPath) {
                            event.input.$[outputPath] = JSON.parse(outputData);
                        } else {
                            event.input.$ = JSON.parse(outputData);
                        }
                    } catch {
                        if (outputPath) {
                            event.input.$[outputPath] = outputData;
                        } else {
                            event.input.$ = outputData;
                        }
                    }

                    // if the last one, return the data
                    // TODO: check this functionality with AWS docs
                    if (index === stateInfo.length - 1) {
                        return callback(null, {
                            statusCode: 200,
                            body: outputData,
                        });
                    }

                    index += 1;
                    spawnProcess(stateInfo, index, event, context, callback);
                });
        }
        `

        // create the handler file
        try {
            fs.writeFileSync(`${this.handlersDirectory}/${stateMachineName}Handler.js`, fileData);
        } catch(e) {
            console.log('e: ', e);
            //directory didn't exist
            if (e.code === 'ENOENT') {
                fs.mkdirSync(this.handlersDirectory);
                fs.writeFileSync(`${this.handlersDirectory}/{stateMachineName}Handler.js`, fileData);
            }
        }
  }

  parseYaml() {
    const servicePath = this.serverless.config.servicePath;
    if (!servicePath) {
        return Promise.resolve();
    }

    const serverlessYmlPath = path.join(servicePath, 'serverless.yml');
    return this.serverless.yamlParser
    .parse(serverlessYmlPath)
    .then(serverlessFileParam =>
        this.serverless.variables.populateObject(serverlessFileParam)
        .then(parsedObject => {
            this.serverless.service.stepFunctions = {};
            this.serverless.service.stepFunctions.stateMachines
                = parsedObject.stepFunctions
            && parsedObject.stepFunctions.stateMachines
                ? parsedObject.stepFunctions.stateMachines : {};
            this.serverless.service.stepFunctions.activities
                = parsedObject.stepFunctions
            && parsedObject.stepFunctions.activities
                ? parsedObject.stepFunctions.activities : [];

            if (!this.serverless.pluginManager.cliOptions.stage) {
                this.serverless.pluginManager.cliOptions.stage = this.options.stage ||
                (this.serverless.service.provider && this.serverless.service.provider.stage) ||
                'dev';
            }

            if (!this.serverless.pluginManager.cliOptions.region) {
            this.serverless.pluginManager.cliOptions.region = this.options.region ||
                (this.serverless.service.provider && this.serverless.service.provider.region) ||
                'us-east-1';
            }

            this.serverless.variables.populateService(this.serverless.pluginManager.cliOptions);
            return Promise.resolve();
        }));
  }
}

module.exports = ServerlessPlugin;

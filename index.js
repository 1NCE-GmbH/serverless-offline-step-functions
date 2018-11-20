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
    this.handlersDirectory = `${__dirname}/src`;

    this.hooks = {
      'before:offline:start:init': () =>
        Promise.bind(this)
        .then(this.parseYaml)
        .then(this.createEndpoints)
        .then(this.createStepFunctionsJSON),
    };
  }

  /**
   * For each statemachine, set up the appropriate endpoint resource to kick off
   * the execution of the state machine and generate a handler file for the endpoint
   * A custom request template is used to send the state machine name and starting
   * state's name to the lambda's execution
   */
  createEndpoints() {
    const functions = this.serverless.service.functions;
    _.forEach(this.serverless.service.stepFunctions.stateMachines, (stateMachine, stateMachineName) => {
        _.forEach(stateMachine.definition.States, (state, stateName) => {
            if (state.Type === 'Task') {
                const lambdaName = this.serverless.providers.aws.naming.extractLambdaNameFromArn(state.Resource);

                // store the lambda function handler in the state for reference in the JSON file
                // it will be used to call the proper handler code when executing the fucntion
                // as part of the state machine
                state.handler = functions[lambdaName].handler;
                if (stateName === stateMachine.definition.StartAt) {
                    // create a new function for an endpoint and
                    // give it a unique name
                    const newFn = {};
                    const functionName = `${lambdaName}StepFunction${Date.now()}`;

                    // give the new function the same events as it's state machine twin
                    newFn.events = Object.assign([], stateMachine.events);

                    // set the handler to the generic state machine handler function
                    newFn.handler = `./node_modules/serverless-offline-step-functions/src/state-machine-handler.run`;
                    _.forEach(newFn.events, (event) => {
                        if (event.http) {
                            event.http.integration = 'lambda';
                            event.http.request = {
                                headers: {
                                    'Content-type': 'application/json'
                                },
                                // this custom template copies (most of) the default template
                                // but also sends the state name and state machine name
                                // TODO: use a file, but need to figure out how to input
                                // TODO:  the stateName, stateMachine name into the file
                                template: {
                                    'application/json': `{
                                        "headers": "$input.params().header",
                                        "stateName": "${stateMachine.definition.StartAt}",
                                        "stateMachine": "${stateMachineName}",
                                        "path": "$input.params().path",
                                        "query": "$input.params().querystring",
                                        "body": "$input.body"
                                    }`,
                                    },
                            };

                            // needed to include response headers otherwise sls offline threw an error:
                            // TypeError: Uncaught error: Cannot read property 'headers' of undefined
                            event.http.response = {
                                headers: {
                                    'Content-type': 'application/json',
                                },
                            };
                        }
                    });

                    // add to serverless functions
                    functions[functionName] = newFn;
                    this.serverless.cli.log(`${this.logPrefix} created ${functionName}`);
                }
            }
        });
    });


  }

  /**
   * Creates a JSON file for reference during the state machine execution
   */
  createStepFunctionsJSON() {
    fs.writeFileSync(`${this.handlersDirectory}/step-functions.json`, JSON.stringify(this.serverless.service.stepFunctions));
  }

  /**
   * Adds the step function configuration to the serverless config
   * @author serverless-step-functions
   */
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

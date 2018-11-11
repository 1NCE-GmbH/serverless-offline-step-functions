'use strict';

const _ = require('lodash');

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      'before:offline:init': this.setupRoutes.bind(this),
    };
  }

  /**
   * Create routes in CF template according
   * to state machine config and add ‘-step-function’
   * to end to distinguish between regular function
   * and step function invocation (suffix may not be needed)
   */
  createEndpoints() {
    // Service.stepFunctions.stateMachines.<name>.definition.States.<state>.Resource
    const functions = this.serverless.service.functions;
    _.forEach(this.serverless.service.stepFunctions.stateMachines, (stateMachine) => {
        const newFn = {};
        newFn = Object.assign({}, stateMachine.events);
        _.forEach(stateMachine.definition.States, (state) => {
            // get function name from arn
            // get function handler/info from service.functions[<name>]
            const lambdaName = this.serverless.providers.aws.naming.extractLambdaNameFromArn(state.Resource);
            newFn.handler = functions[lambdaName].handler;
            functions[`${lambdaName}StepFunction${Date.now()}`];
        });
    });

  }
}

module.exports = ServerlessPlugin;

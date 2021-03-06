const child_process = require('child_process');
const _ = require('lodash');
const fs = require('fs');
const jsonPath = require('JSONPath');
const choiceProcessor = require('./choice-processor');
const stateTypes = require('./state-types');
const StateRunTimeError = require('./state-machine-error');

const logPrefix = '[Serverless Offline Step Functions]:';

/**
 * InputPath and Parameters select parts from the state input to be sent to the task resource (lambda)
 *  - InputPath precedes Paramaters selection
 * ResultPath defines the target path to store the task's output in the original state input
 *  - Leave our ResultPath to keep the original state input
 *  - Set to null to not include task's output
 * OutputPath is used to select parts of the whole state input (including ResultPath changes) as the state output
 * All paths are json paths.
 * There's a lot more to it, but these are the basics. Not all features are implemented here.
 * See https://docs.aws.amazon.com/step-functions/latest/dg/concepts-input-output-filtering.html
 */

class StateMachineExecutor {
    constructor(stateMachineName, stateName, stateMachineJSONInput) {
        this.currentStateName = stateName;
        this.stateMachineName = stateMachineName;
        this.stateMachineJSON = {};
        if (stateMachineJSONInput) {
            this.stateMachineJSON.stateMachines = _.assign({}, this.stateMachineJSON.stateMachines, stateMachineJSONInput);
        } else {
            try {
                const json = require('./step-functions.json');
                if (!_.isEmpty(json)) {
                    this.stateMachineJSON = json;
                }
            } catch (e) {
                throw new Error('no state machine json found');
            }
        }
        // step execution response includes the start date
        this.startDate = Date.now();
        // step execution response includes the execution ARN
        // use this for now to give a unique id locally
        this.executionArn = `${stateMachineName}-${stateName}-${this.startDate}`;
    }

    /**
     * Spawns a new process to run a given State from a state machine
     * @param {*} stateInfo
     * @param {*} input
     * @param {*} context
     */
    spawnProcess(stateInfo, input, context, callback = null) {
        console.log(`* * * * * ${this.currentStateName} * * * * *`);
        // This will be used as the parent node key for when the process
        // finishes and its output needs to be processed.
        console.log('state input: \n', JSON.stringify(input, 0, 2), '\n');
        const outputKey = `sf-${Date.now()}`;

        let taskInput = this.processTaskInput(input, stateInfo);
        console.log('task input: \n', JSON.stringify(taskInput, 0, 2), '\n');

        const child = child_process.spawn('node',
            [
                '-e',
                this.whatToRun(stateInfo, taskInput, outputKey, callback)],
            {
                stdio: 'pipe',
                env: Object.assign({}, process.env, {
                    input: JSON.stringify(taskInput),
                })
            });

        let outputData = null;
        child.stdout.on('data', (data) => {
            if (Buffer.isBuffer(data) &&
                stateInfo.Type !== stateTypes.FAIL) {
                data = data.toString().trim();

                try {
                    // check that output is a JSON string
                    const parsed = JSON.parse(data);
                    // only process data if sent as step functions output so data from
                    // other console.logs don't get processed
                    if (typeof parsed[outputKey] !== 'undefined') {
                        outputData = parsed[outputKey];
                    }
                } catch (error) {
                    console.log(`${logPrefix} error processing data: ${data}`);
                }
            }
        });


        child.stderr.on('data', (data) => {
            console.error(`${logPrefix} stderr:`, data.toString())
        });

        child.on('exit', () => {
            let output = null;
            // any state except the fail state may have OutputPath
            if (stateInfo.Type !== 'Fail') {
                // state types Parallel, Pass, and Task can generate a result and can include ResultPath
                if ([stateTypes.PARALLEL, stateTypes.PASS, stateTypes.TASK].indexOf(stateInfo.Type) > -1) {
                    input = this.processTaskResultPath(input, stateInfo, (outputData || {}));
                }

                // NOTE:
                // State machine data is represented by JSON text, so you can provide values using any data type supported by JSON
                // https://docs.aws.amazon.com/step-functions/latest/dg/concepts-state-machine-data.html
                output = this.processTaskOutputPath(input, stateInfo.OutputPath);
            }
            // kick out if it is the last one (end => true) or state is 'Success' or 'Fail
            if (stateInfo.Type === 'Succeed' || stateInfo.Type === 'Fail' || stateInfo.End === true) {
                return this.endStateMachine(null, null, output);
            }

            // const newEvent = event ? Object.assign({}, event) : {};
            // newEvent.input = event.output;
            // newEvent.stateName = stateInfo.Next;
            this.currentStateName = stateInfo.Next;
            stateInfo = this.stateMachineJSON.stateMachines[this.stateMachineName].definition.States[stateInfo.Next];
            console.log('output: \n', JSON.stringify(output, 0, 2), '\n');
            this.spawnProcess(stateInfo, output, context, callback);
        });
    }

    endStateMachine(error, input, output, message) {
        if (error) {
            console.error(`${logPrefix} Error:`, error);
        } else {
            console.log(`${logPrefix} State Machine Completed`);
        }

        if (message) {
            console.log(`${logPrefix}`, message);
        }

        if (input) {
            console.log(`${logPrefix} input:`, input);
        }

        console.log(`${logPrefix} output: \n`, JSON.stringify(output, 0, 2), '\n');
        return true;
    }

    /**
     * tris to get the transpiled webpack function, if exists. Else, it should get the common function directly.
     */
    getWebpackOrCommonFuction(path) {
        const webpackPath = `./.webpack/service/${path}.js`
        const webpackFileExists = fs.existsSync(webpackPath);

        return (
            webpackFileExists
                ? webpackPath
                : `./${path}`
        );
    }

    /**
     * decides what to run based on state type
     * @param {object} stateInfo
     */
    whatToRun(stateInfo, input, outputKey, callback) {
        switch (stateInfo.Type) {
            case 'Task':
                // TODO: catch, retry
                // This will spin up a node child process to fire off the handler function of the given lambda
                // the output of the lambda is placed into a JSON object with the outputKey generated above as
                // the parent node and piped to stdout for processing. This is done so other callback console.logs are not
                // processed by this plugin.
                // process.exit(0) must be called in .then because a child process will not exit if it has connected
                // to another resource, such as a database or redis, which may be a source of future events.
                const lastDotIndex = stateInfo.handler.lastIndexOf('.');
                const handlerFile = stateInfo.handler.substring(0, lastDotIndex);
                const handlerName = stateInfo.handler.substring(lastDotIndex + 1);
                // const cb = callback(null, { statusCode: 200, body: JSON.stringify({ startDate: sme.startDate, executionArn: sme.executionArn }) });
                // const context = ;
                let runner = `const context = require('./node_modules/serverless-offline-step-functions/node_modules/serverless-offline/src/createLambdaContext')(require('${this.getWebpackOrCommonFuction(handlerFile)}').${handlerName}, ${callback}); `;
                runner += `Promise.resolve(require("${this.getWebpackOrCommonFuction(handlerFile)}").${handlerName}(JSON.parse(process.env.input), context, ${callback}))`;
                runner += `.then((data) => { console.log(JSON.stringify({ "${outputKey}": data || {} })); process.exit(0); })`;
                runner += `.catch((e) => { console.error("${logPrefix} handler error:",e); })`;
                return runner;

            // should pass input directly to output without doing work
            case 'Pass':
                return '';
            // Waits before moving on:
            // - Seconds, SecondsPath: wait the given number of seconds
            // - Timestamp, TimestampPath: wait until the given timestamp
            case 'Wait':
                return this.buildWaitState(stateInfo, input);
            // ends the state machine execution with 'success' status
            case 'Succeed':
            // ends the state machine execution with 'fail' status
            case 'Fail':
                return this.endStateMachine(null, stateInfo);
            // adds branching logic to the state machine
            case 'Choice':
                stateInfo.Next = choiceProcessor.processChoice(stateInfo, input);
                return '';
            case 'Parallel':
                return `console.error('${logPrefix} 'Parallel' state type is not yet supported by serverless offline step functions')`;
            default:
                return `console.error('${logPrefix} Invalid state type: ${stateInfo.Type}')`
        }
    }

    buildWaitState(stateInfo, input) {
        let milliseconds;
        // SecondsPath: specified using a path from the state's input data.
        if ((stateInfo.Seconds && _.isNaN(+stateInfo.Seconds))) {
            milliseconds = +stateInfo.Seconds * 1000
        } else if (stateInfo.SecondsPath && input) {
            milliseconds = +jsonPath({json: input, path: stateInfo.SecondsPath})[0] * 1000;
        } else if (stateInfo.Timestamp) {
            const waitDate = new Date(stateInfo.Timestamp);
            if (waitDate.getTime() < Date.now()) {
                milliseconds = 0;
            } else {
                milliseconds = waitDate.getTime() - Date.now();
            }
        } else if (stateInfo.TimestampPath && input) {
            const waitDate = new Date(jsonPath({json: input, path: stateInfo.TimestampPath})[0]);
            if (waitDate.getTime() < Date.now()) {
                milliseconds = 0;
            } else {
                milliseconds = waitDate.getTime() - Date.now();
            }
        }

        if (_.isNaN(milliseconds)) {
            return '' + this.endStateMachine(
                new StateRunTimeError('Specified wait time is not a number'), stateInfo);
        }

        return `setTimeout(() => {}, ${+milliseconds});`;
    }

    //TODO: check if task (lambda) input is the same concept as state input
    //TODO: first apply input path filtering, then parameter filtering. They're not mutually exclusive
    processTaskInput(input, stateInfo) {
        if (typeof stateInfo.Parameters !== 'undefined') {
            return this.processTaskInputParameters(input, stateInfo);
        } else {
            return this.processTaskInputPath(input, stateInfo);
        }
    }

    /**
     * Process the state's InputPath - per AWS docs:
     * The InputPath field selects a portion of the state's input to pass to the state's
     * task for processing. If you omit the field, it gets the $ value, representing the
     * entire input. If you use null, the input is discarded (not sent to the state's
     * task) and the task receives JSON text representing an empty object {}.
     * https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-input-output-processing.html
     * @param {*} input
     * @param {*} stateInfo
     */
    processTaskInputPath(input, stateInfo) {
        stateInfo.InputPath = typeof stateInfo.InputPath === 'undefined' ? '$' : stateInfo.InputPath;
        if (stateInfo.InputPath === null) {
            input = {};
        } else {
            input = input ? input : {};
            jsonPath({
                json: input, path: stateInfo.InputPath, callback: (data) => {
                    input = Object.assign({}, data);
                }
            });
        }

        return input;
    }

    /**
     * Use "Parameters" field to create a collection of key-value pairs that are passed as input.
     * The values of each can either be static values that you include in your state machine definition,
     * or selected from either the input or the context object with a path.
     * For key-value pairs where the value is selected using a path, the key name must end in .$.
     * https://docs.aws.amazon.com/step-functions/latest/dg/input-output-inputpath-params.html
     *
     * This function cannot not with nested complex types as "target" path
     * nor can it deal with static values (yet)
     * TODO: static values
     * TODO: nested target paths (complex target types)
     * @param input
     * @param StateInfo
     */
    processTaskInputParameters(input, StateInfo) {
        let newInput = {};
        //Selectively grab data from input
        for (let [targetPath, sourcePath] of Object.entries(StateInfo.Parameters)) {
            jsonPath({
                json: input, path: sourcePath, callback: (data) => {
                    this.addDataToInput(newInput, targetPath, data);
                }
            });
        }

        return Object.assign({}, newInput);
    }

    /**
     * Moves the result of the task to the path specified by ResultPath in
     * the task's input according to the state's config.
     * AWS docs on processing of input/output:
     * https://docs.aws.amazon.com/step-functions/latest/dg/input-output-paths.html
     * @param {*} event
     * @param {*} stateInfo
     * @param {string} resultData
     */
    processTaskResultPath(input, stateInfo, resultData) {
        const path = typeof stateInfo.ResultPath === 'undefined' ? '$' : stateInfo.ResultPath;

        return this.addDataToInput(input, path, resultData);
    }

    addDataToInput(input, path, data) {
        let exprList = jsonPath.toPathArray(path);
        if (exprList[0] === '$' && exprList.length > 1) {
            exprList.shift();
        }
        let resultObject = data;
        exprList.reduceRight((_, item) => {
            if (item !== '$') {
                let temp = {};
                temp[item] = resultObject;
                resultObject = Object.assign({}, temp);
            }
        }, null);

        return Object.assign(input, resultObject);
    }

    /**
     * OutputPath:
     * If OutputPath is **NOT** specified, the entire (original) input is set to output
     * If OutputPath is specified, only the specified node (from the input) is returned
     * If the OutputPath is null, JSON text representing an empty object {} is sent to the next state.
     * If the OutputPath doesn't match an item in the state's input, an exception specifies an invalid path
     * For more information, see Input and Output Processing.
     * https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-common-fields.html
     * @param {*} event
     * @param {*} stateInfo
     */
    processTaskOutputPath(data, path) {
        let output = null;
        if (path !== null) {
            output = jsonPath({json: data, path: path || '$',})[0];

            if (!output) {
                return this.endStateMachine(
                    new StateRunTimeError(`An error occurred while executing the state '${this.currentStateName}'. Invalid OutputPath '${path}': The Output path references an invalid value.`),
                    data);
            }
        }

        return output;
    }
}

module.exports = StateMachineExecutor;

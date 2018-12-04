const Promise = require('bluebird');
const child_process = require('child_process');
const stateMachineJSON = require('./step-functions.json');
const _ = require('lodash');
const jsonPath = require('JSONPath');
const choiceProcessor = require('./choice-processor');
const stateTypes = require('./state-types');

const logPrefix = '[Serverless Offline Step Functions]:';
const ERROR = 'error';

class StateMachineExecutor {
    constructor(stateMachineName, stateName) {
        // step execution response includes the start date
        this.startDate = Date.now();
        // step execution response includes the execution ARN
        // use this for now to give a unique id locally
        this.executionArn = `${stateMachineName}-${stateName}-${this.startDate}`;
    }

    /**
     * Spawns a new process to run a given State from a state machine
     * @param {*} stateInfo
     * @param {*} event
     * @param {*} context
     */
    spawnProcess(stateInfo, event, context) {
        console.log('stateInfo: ', stateInfo);
        // This will be used as the parent node key for when the process
        // finishes and its output needs to be processed.
        const outputKey = `sf-${Date.now()}`;

        // clear output, it will be processed later
        event.output = undefined;

        this.processTaskInputPath(event, stateInfo);

        const child = child_process.spawn('node',
        [
            '-e',
            this.whatToRun(stateInfo, event, outputKey)],
            { stdio: 'pipe',
            env: Object.assign({}, process.env, {
                event: JSON.stringify(event),
                context: JSON.stringify(context)
            })});

            let outputData = null;
            child.stdout.on('data', (data) => {
                if (Buffer.isBuffer(data) && stateInfo.Type !== stateTypes.FAIL) {
                    data = data.toString().trim();

                    try {
                        // check that output is a JSON string
                        const parsed = JSON.parse(data);
                        // only process data if sent as step functions output so data from
                        // other console.logs don't get processed
                        if (typeof parsed[outputKey] !== 'undefined') {
                            outputData = JSON.stringify(parsed[outputKey]);
                        }
                    } catch(error) {
                        console.log(data.toString());
                    }
                }
            });


            child.stderr.on('data', (data) => {
                console.error(`${logPrefix} ${data.toString()}`)
            });

            child.on('exit', () => {
                // any state except the fail state may have OutputPath
                if(stateInfo.Type !== 'Fail') {
                    this.processTaskResultPath(event, stateInfo, outputData);

                    // NOTE:
                    // State machine data is represented by JSON text, so you can provide values using any data type supported by JSON
                    // https://docs.aws.amazon.com/step-functions/latest/dg/concepts-state-machine-data.html
                    this.processTaskOutputPath(event, stateInfo);

                }
                // kick out if it is the last one (end => true) or state is 'Success' or 'Fail
                if (stateInfo.Type === 'Success' || stateInfo.Type === 'Fail' || stateInfo.End === true) {
                    return this.endStateMachine(event);
                }

                const newEvent = event ? Object.assign({}, event) : {};
                newEvent.input = event.output;
                newEvent.stateName = stateInfo.Next;
                stateInfo = stateMachineJSON.stateMachines[event.stateMachine].definition.States[stateInfo.Next];
                this.spawnProcess(stateInfo, newEvent, context);
            });
    }

    endStateMachine(event, message, endStatus) {
        if( endStatus && endStatus === ERROR) {
            console.error(`${logPrefix} State Machine Failed with an Error`);
        } else {
            console.log(`${logPrefix} State Machine Completed`);
        }

        if (message) {
            console.log(`${logPrefix}`, message);
        }

        console.log(`${logPrefix} event:`, event);
        return event;
    }

    /**
     * decides what to run based on state type
     * @param {object} stateInfo
     */
    whatToRun(stateInfo, event, outputKey) {
        switch(stateInfo.Type) {
            case 'Task':
                // TODO: catch, retry
                // This will spin up a node child process to fire off the handler function of the given lambda
                // the output of the lambda is placed into a JSON object with the outputKey generated above as
                // the parent node and piped to stdout for processing. This is done so other console.logs are not
                // processed by this plugin.
                // process.exit(0) must be called in .then because a child process will not exit if it has connected
                // to another resource, such as a database or redis, which may be a source of future events.
                const handlerSplit = stateInfo.handler.split('.');
                let runner = `require("./${handlerSplit[0]}").${handlerSplit[1]}(JSON.parse(process.env.event), JSON.parse(process.env.context))`;
                runner += `.then((data) => { const out = JSON.parse(data); console.log(JSON.stringify({ "${outputKey}": out })); process.exit(0); })`;
                runner += `.catch((e) => { console.error("${logPrefix}",e); })`;
                return runner;

            // should pass input directly to output without doing work
            case 'Pass':
                return '';
            // Waits before moving on:
            // - Seconds, SecondsPath: wait the given number of seconds
            // - Timestamp, TimestampPath: wait until the given timestamp
            case 'Wait':
                return this.buildWaitState(stateInfo, event);
            // ends the state machine execution with 'success' status
            case 'Succeed':
            // ends the state machine execution with 'fail' status
            case 'Fail':
                return this.endStateMachine(stateInfo);
            // adds branching logic to the state machine
            case 'Choice':
                this.processChoices(stateInfo, event);
                return '';
            case 'Parallel':
                return `console.error('${logPrefix} 'Parallel' state type is not yet supported by serverless offline step functions')`;
            default:
                return `console.error('${logPrefix} Invalid state type: ${stateInfo.Type}')`
        }
    }

    buildWaitState(stateInfo, event) {
        let milliseconds = 0;
        // SecondsPath: specified using a path from the state's input data.
        if ((stateInfo.Seconds && _.isNaN(+stateInfo.Seconds))) {
            milliseconds = +stateInfo.Seconds
        } else if (stateInfo.SecondsPath && event.input) {
            milliseconds = +jsonPath({ json: event.input, path: stateInfo.SecondsPath })[0];
        }

        if (_.isNaN(milliseconds)) {
            return ''+ this.buildExecutionEndResponse(stateInfo);
        }

        return `setTimeout(() => {}, ${+milliseconds*1000});`;
    }

    /**
     *
     * @param {*} stateInfo
     * @param {*} event
     */
    processChoices(stateInfo, event) {
        // AWS docs:
        // Step Functions examines each of the Choice Rules in the order listed
        // in the Choices field and transitions to the state specified in the
        // Next field of the first Choice Rule in which the variable matches the
        // value according to the comparison operator
        // https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-choice-state.html
        _.forEach(stateInfo.Choices, (choice) => {
            const keys = Object.keys(choice);
            let choiceComparator = '';
            if (choice.Not) {
                choiceComparator = 'Not';
                choice = choice.Not;
            } else if (choice.And) {
                choiceComparator = 'And';
                choice = choice.And;
            } else if (choice.Or) {
                choiceComparator = 'Or';
                choice = choice.Or;
            } else {
                choiceComparator = _.filter(keys, key => key !== 'Variable' && key !== 'Next');

                if (choiceComparator.length > 1) {
                    return this.endStateMachine(event, 'mulitple choice comparison keys found');
                }

                choiceComparator = choiceComparator[0];
            }

            if (choice.Default) {
                stateInfo.Next = choice.Default;
                return false; // short circuit forEach
            } else if (choiceProcessor.processChoice(choiceComparator, choice, event)) {
                stateInfo.Next = choice.Next;
                return false; // short circuit forEach
            }
        });
    }

    /**
     * Process the state's InputPath - per AWS docs:
     * The InputPath field selects a portion of the state's input to pass to the state's
     * task for processing. If you omit the field, it gets the $ value, representing the
     * entire input. If you use null, the input is discarded (not sent to the state's
     * task) and the task receives JSON text representing an empty object {}.
     * https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-input-output-processing.html
     * @param {*} event
     * @param {*} stateInfo
     */
    processTaskInputPath(event, stateInfo) {
        stateInfo.InputPath = typeof stateInfo.InputPath === 'undefined' ? '$' : stateInfo.InputPath;
        if (stateInfo.InputPath === null) {
            event.input = '{}';
        } else {
            let input = event.input ? event.input : '{}';
            jsonPath({ json: input, path: stateInfo.InputPath, callback: (data) => {
                event.input = JSON.stringify(Object.assign({}, JSON.parse(data)));
            }});
        }
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
    processTaskResultPath(event, stateInfo, resultData) {
        // according to AWS docs:
        // ResultPath (Optional)
        // A path that selects a portion of the state's input to be passed to the state's output.
        // If omitted, it has the value $ which designates the entire input.
        // For more information, see Input and Output Processing.
        // https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-common-fields.html
        try {
            const input = event.input ? JSON.parse(event.input) : {};
            jsonPath({ json: resultData, path: stateInfo.ResultPath || '$', callback: (data) => {
                event.input = JSON.stringify(Object.assign(input || {}, JSON.parse(data)));
            }});
        } catch(error) {
            return this.endStateMachine(event, `Error processing task result`);
        }
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
    processTaskOutputPath(event, stateInfo) {
        event.output = '{}';
        if (stateInfo.OutputPath !== null) {
            jsonPath({ json: event.input, path: stateInfo.OutputPath || '$', callback: (data) => {
                if (!data) {
                    return this.endStateMachine(event, 'OutputPath is an invalid JSON path', ERROR);
                }
                event.output = JSON.stringify(Object.assign({}, JSON.parse(data)));
            }});
        }
    }
}

module.exports = StateMachineExecutor;

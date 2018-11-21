const child_process = require('child_process');
const stateMachineJSON = require('./step-functions.json');
const _ = require('lodash');
const jsonPath = require('JSONPath');
const choiceProcessor = require('./choice-processor');

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
     * @param {*} callback
     */
    spawnProcess(stateInfo, event, context, callback) {
        this.callback = callback;

        const child = child_process.spawn('node',
        [
            '-e',
            this.whatToRun(stateInfo, event)],
            { stdio: 'pipe',
            env: Object.assign({}, process.env, {
                event: JSON.stringify(event),
                context: JSON.stringify(context)
            })});

            let outputData = null;
            child.stdout.on('data', (data) => {
                if (Buffer.isBuffer(data) && ['fail', 'pass', 'success', 'wait'].indexOf(stateInfo.Type.toLowerCase()) < 0) {
                    data = data.toString().trim();
                }

                outputData = data;
            });
            child.stderr.on('data', (data) => {
                console.error('[offline step functions] Error: ', data.toString());
            });

            child.on('exit', () => {
                const outputPath = stateInfo.OutputPath;
                const newEvent = event ? Object.assign({}, event) : {};

                // any state except the fail state may have output
                if(stateInfo.Type !== 'Fail') {
                    this.processResult(event, stateInfo, outputData);

                    // if OutputPath is **NOT** specified, the entire (original) input is set to output
                    // if OutputPath is specified, only the specified node (from the input) is returned
                    jsonPath({ json: event.input, path: outputPath || '$', callback: (data) =>{
                        event.output = Object.assign({}, data);
                    }});

                }
                // kick out if it is the last one (end => true) or state is 'Success' or 'Fail
                if (stateInfo.Type === 'Success' || stateInfo.Type === 'Fail' || stateInfo.End === true) {
                    return this.buildExecutionEndResponse(stateInfo);
                }

                newEvent.input = Object.assign(event.input || {}, event.output);

                newEvent.stateName = stateInfo.Next;
                stateInfo = stateMachineJSON.stateMachines[event.stateMachine].definition.States[stateInfo.Next];
                this.spawnProcess(stateInfo, newEvent, context, callback);
            });
    }

    /**
     * Build a response to use upon the termination of the
     * state machine's execution
     */
    buildExecutionEndResponse(stateInfo) {
        // TODO: return error object of execution
        const error = stateInfo.Type === 'Fail' ?
        { statusCode: 500, message: `${this.executionArn} failed`} :
        null;

        const response = stateInfo.Type === 'Fail' ? null :
            { statusCode: 200, body: JSON.stringify({ startDate: this.startDate, executionArn: this.executionArn })};
        return this.callback(error, response);
    }

    /**
     * decides what to run based on state type
     * @param {object} stateInfo
     */
    whatToRun(stateInfo, event) {
        switch(stateInfo.Type) {
            case 'Task':
                // TODO: catch, retry
                const handlerSplit = stateInfo.handler.split('.');
                return `require("./${handlerSplit[0]}").${handlerSplit[1]}(JSON.parse(process.env.event), JSON.parse(process.env.context)).then((data) => { console.log(JSON.stringify(data))})`;
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
                return ''+ this.buildExecutionEndResponse(stateInfo, this.callback);
            // adds branching logic to the state machine
            case 'Choice':
                this.processChoices(stateInfo, event);
                return '';
            case 'Input':
            case 'Output':
            case 'Parallel':
            default:
                return `console.error('${stateInfo.Type}')`
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
            return ''+ this.buildExecutionEndResponse(stateInfo, this.callback);
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
                    throw new Error('mulitple choice comparison keys found');
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
     * Moves the result of the task to the specified ResultPath in
     * the task's input according to the state's config.
     * AWS docs on processing of input/output:
     * https://docs.aws.amazon.com/step-functions/latest/dg/input-output-paths.html
     * @param {*} event
     * @param {*} stateInfo
     * @param {*} outputData
     */
    processResult(event, stateInfo, outputData) {
        // according to AWS docs:
        // ResultPath then selects what combination of the state input and the task result to pass to the output.
        // If ResultPath is specified, the result of the task should be stored at that path
        // as a child node in the original state machine input
        try {
            const result = JSON.parse(outputData);
            event.input = event.input || {};
            if(stateInfo.ResultPath) {
                const pathPieces = stateInfo.ResultPath.split('.');

                // AWS state language uses JSON path syntax
                // https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-input-output-processing.html
                // $ is the root object, so we can ignore when setting
                // the result path data
                if (pathPieces[0] === '$') {
                    pathPieces.shift();
                }
                // move the result data into the input object
                // building according to ResultPath config
                const currentObj = event.input;
                _.forEach(pathPieces, (path, index) => {
                    if(index === pathPieces.length - 1) {
                        currentObj[path] = result;
                    } else {
                        currentObj[path] = {};
                    }
                });
            } else {
                // TODO: double check this is correct (no ResultPath defined)
                event.input = Object.assign(event.input, result);
            }
        } catch(error) {
            return this.callback(error, null);
        }
    }
}

module.exports = StateMachineExecutor;
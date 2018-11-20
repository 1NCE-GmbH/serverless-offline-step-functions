const child_process = require('child_process');
const stateMachineJSON = require('./step-functions.json');
const _ = require('lodash');
const jsonPath = require('JSONPath');

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
        const outputPath = stateInfo.OutputPath;
        const nodeOptsArr = [
            '-e',
            this.whatToRun(stateInfo)];

        if(stateInfo.Type.toLowerCase() !== 'wait') {
            nodeOptsArr.push('-');
        }

        const child = child_process.spawn('node',
        [
            '-e',
            this.whatToRun(stateInfo)],
            { stdio: 'pipe',
            env: Object.assign({}, process.env, {
                event: JSON.stringify(event),
                context: JSON.stringify(context)
            })});

            let outputData = null;
            child.stdout.on('data', (data) => {
                if (Buffer.isBuffer(data) && ['fail', 'pass', 'success', 'wait'].indexOf(stateInfo.Type.toLowerCase()) < 0) {
                    data = JSON.parse(data.toString().trim());
                }

                outputData = data;
            });
            child.stderr.on('data', (data) => {
                console.error('[offline step functions] Error: ', data.toString());
            });

            child.on('exit', () => {
                // kick out if it is the last one (end => true) or state is 'Success' or 'Fail
                if (stateInfo.Type === 'Success' || stateInfo.Type === 'Fail' || stateInfo.End === true) {
                    return this.buildExecutionEndResponse(stateInfo);
                }

                const newEvent = event ? Object.assign({}, event) : {};
                event.output = event.output || {};
                try {
                    if (outputPath) {
                        event.output[outputPath] = JSON.parse(outputData);
                    } else {
                        event.output = JSON.parse(outputData);
                    }
                } catch (error) {
                    if (error.message.indexOf('JSON at position') > -1){
                        if(outputPath) {
                            event.output[outputPath] = outputData;
                        } else {
                            event.output = outputData;
                        }
                    } else {
                        throw error;
                    }
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
    whatToRun(stateInfo) {
        switch(stateInfo.Type) {
            case 'Task':
                // TODO: catch, retry
                const handlerSplit = stateInfo.handler.split('.');
                return `require("./${handlerSplit[0]}").${handlerSplit[1]}(JSON.parse(process.env.event), JSON.parse(process.env.context)).then((data) => { console.log(JSON.stringify(data))})`;
            // should pass input directly to output without doing work
            case 'Pass':
            // Waits before moving on:
            // - Seconds, SecondsPath: wait the given number of seconds
            // - Timestamp, TimestampPath: wait until the given timestamp
            case 'Wait':
                return this.buildWaitState(stateInfo);
            // ends the state machine execution with 'success' status
            case 'Succeed':
            // ends the state machine execution with 'fail' status
            case 'Fail':
                return ''+ this.buildExecutionEndResponse(stateInfo, this.callback);
            // adds branching logic to the state machine
            case 'Choice':
            case 'Input':
            case 'Output':
            case 'Parallel':
            default:
                return `console.log('${stateInfo.Type}')`
        }
    }

    buildWaitState(stateInfo, event) {
        // SecondsPath: specified using a path from the state's input data.
        if ((stateInfo.Seconds && _.isNaN(+stateInfo.Seconds)) ||
            (stateInfo.SecondsPath && event.input && _.isNaN(+event.input[stateInfo.SecondsPath]))) {
            return ''+ this.buildExecutionEndResponse(stateInfo, this.callback);
        }

        const seconds = stateInfo.Seconds || event.input[stateInfo.SecondsPath];
        return `setTimeout(() => { return true; }, ${+seconds});`;
    }
}

module.exports = StateMachineExecutor;
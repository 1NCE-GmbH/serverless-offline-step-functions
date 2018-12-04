const StateMachineExecutor = require('./state-machine-executor')
const stateMachineJSON = require('./step-functions.json');

/**
 * generalized handler for a state machine
 */
module.exports.run = (event, context, callback) => {
    const sme = new StateMachineExecutor(event.stateMachine, event.stateName);
    const stateInfo = stateMachineJSON.stateMachines[event.stateMachine].definition.States[event.stateName];
    sme.spawnProcess(stateInfo, event, context);

    // per docs, step execution response includes the start date and execution arn
    return callback(null, { statusCode: 200, body: JSON.stringify({ startDate: sme.startDate, executionArn: sme.executionArn }) });
}

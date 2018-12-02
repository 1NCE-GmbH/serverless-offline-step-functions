const StateMachineExecutor = require('./state-machine-executor')
const stateMachineJSON = require('./step-functions.json');

/**
 * generalized handler for a state machine
 */
module.exports.run = (event, context, callback) => {
    const sme = new StateMachineExecutor(event.stateMachine, event.stateName);
    // TODO: args for script file - see parsePath below
    if (typeof event.pathParameters === 'string') {
        event.pathParameters = parsePath(event.pathParameters);
    }

    // TODO: args for script file - see parsePath below
    if (typeof event.queryStringParameters === 'string') {
        event.queryStringParameters = parsePath(event.queryStringParameters);
    }

    // TODO: args for script file - see parsePath below
    if (typeof event.headers === 'string') {
        event.headers = parsePath(event.headers);
    }

    if (typeof event.body !== 'string') {
        event.body = JSON.stringify(event.body);
    }

    const stateInfo = stateMachineJSON.stateMachines[event.stateMachine].definition.States[event.stateName];
    sme.spawnProcess(stateInfo, event, context);

    // per docs, step execution response includes the start date and execution arn
    return callback(null, { statusCode: 200, body: JSON.stringify({ startDate: sme.startDate, executionArn: sme.executionArn }) });
}

 /**
 * TODO: can args be passed to script file in sls yml?
 * Parses the parameter string into a JSON object
 * i.e. path params will come in as a string: '{key1=val1,key2=val2}'
 * this would return { key1: val1, key2: val2 }
 * @param {string} paramString
 */
function parsePath(paramString) {
    const paramObj = {};
    paramString.replace(/{|}/g, '').split(',').forEach((piece) => {
        const keyVal = piece.split('=');
        paramObj[keyVal[0].trim()] = keyVal[1] || keyVal[0];
    });

    return paramObj;
}

const StateMachineExecutor = require('./state-machine-executor')
const stateMachineJSON = require('./step-functions.json');

/**
 * generalized handler for a state machine
 */
module.exports.run = (event, context, callback) => {
    const sme = new StateMachineExecutor(event.stateMachine, event.stateName);
    // TODO: args for script file - see parsePath below
    if (typeof event.path === 'string') {
        event.pathParameters = parsePath(event.path);
    }

    // TODO: args for script file - see parsePath below
    if (typeof event.query === 'string') {
        event.queryString = parsePath(event.query);
    }

    // TODO: args for script file - see parsePath below
    if (typeof event.headers === 'string') {
        event.headers = parsePath(event.headers);
    }

    const stateInfo = stateMachineJSON.stateMachines[event.stateMachine].definition.States[event.stateName]
    sme.spawnProcess(stateInfo, event, context, callback)
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
        paramObj[keyVal[0]] = keyVal[1] || keyVal[0];
    });

    return paramObj;
}

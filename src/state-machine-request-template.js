/**
 * Request template used to emulate StepFunctions input from
 * ApiGateway Events with Serverless offline. The state name and state
 * machine name are added in so the plugin knows where to start which
 * state machine.
 *
 * StepFunctions only sends the body object to the input from the http
 * event of ApiGateway.
 */
module.exports = (stateMachineName, stateName ) => {
    return `{
        "input": \$input.json("$"),
        "stateName": "${stateName}",
        "stateMachine": "${stateMachineName}"
      }`
}
/**
 * Request template used to emulate ApiGateway Events with
 * Serverless offline adding in the state name and state
 * machine name
 */
module.exports = (stateMachineName, stateName ) => {
    return `#define( $loop )
    {
    #foreach($key in $map.keySet())
      "$util.escapeJavaScript($key)":
        "$util.escapeJavaScript($map.get($key))"
        #if( $foreach.hasNext ) , #end
    #end
    }
    #end
    {
      "body": $input.json("$"),
      "method": "$context.httpMethod",
      "principalId": "$context.authorizer.principalId",
      #set( $map = $input.params().header )
      "headers": $loop,
      #set( $map = $input.params().querystring )
      "querystringParameters": $loop,
      #set( $map = $input.params().path )
      "pathParameters": $loop,
      #set( $map = $context.identity )
      "identity": $loop,
      #set( $map = $stageVariables )
      "stageVariables": $loop,
      "stateName": "${stateName}",
      "stateMachine": "${stateMachineName}"
    }`
}
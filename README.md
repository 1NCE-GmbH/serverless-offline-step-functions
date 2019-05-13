# serverless-offline-step-functions
Serverless Offline plugin to support step functions.

## Installation
```
# dependencies:
$ npm install -D serverless-offline, serverless-step-functions

# the fun stuff
$ npm install -D serverless-offline-step-functions
```

## Usage
- Add to **plugins** section in `serverless.yml`:

```
plugins:
  - serverless-step-functions
  - serverless-offline-step-functions
  - serverless-offline
```
- If your resources have a prefix added during deploy time, add the `resourcePrefix` confing to the `serverless.yml` **custom** section. This will allow `serverless-offline-step-functions` to find the resources. See below for an example:
```
custom:
  serverless-offline-step-functions:
    resourcePrefix: ${self:service}-${self:provider.stage}-
```
- If you use serverless-webpack add your custom path where the build file are saved from the webpack build
```
custom:
  serverless-offline-step-functions:
    customPath: '.webpack/service'
```

## Server
The plugin also sets up a server to run any lambdas that make use of the StepFunctions API in the `aws-sdk`. The default port is `8014`; however, you can specify which port to listen to like so:
```
custom:
  serverless-offline-step-functions:
    port: 8014
```

Serveless Offline will now be able to run your state machines similar to AWS!

## Supported States
- [x] Task
- [x] Pass
- [x] Wait
- [x] Succeed
- [x] Fail
- [x] Choice
- [ ] Parallel

## Example Project and Docs
For a full (Hello World) example project, take a look at this repo:

[Learning AWS Step Functions](https://github.com/jkruse14/learning-aws-step-functions)

For a walkthrough of the example project and to learn more about AWS States and Step Functions, checkout my post on `Medium`:

[Stepping Through AWS Step Functions]()

For AWS' documentation, you can start here:

[What Is AWS Step Functions?](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)

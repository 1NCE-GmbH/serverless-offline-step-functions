'use strict';

const _ = require('lodash');
const path = require('path');
const Promise = require('bluebird');
const fs = require('fs');
// const Endpoint = require('../serverless-offline/lib/Endpoint');
// const functionHelper = require('../serverless-offline/lib/functionHelper');

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.logPrefix = '[Offline Step Functions] ';
    // TODO: add config?
    this.handlersDirectory = `./node_modules/serverless-offline-step-functions/src`;
    this.serverlessLog = serverless.cli.log.bind(serverless.cli);
    this.offline = _.find(this.serverless.pluginManager.plugins, (plugin) => plugin.constructor.name.toLowerCase() === 'offline');
    // console.log('this.offline: ', this.offline);

    // this.server = this.offline.server;

    this.hooks = {
        'offline:start:init': () =>
            Promise.bind(this)
            .then(this.parseYaml)
            // TODO: validate state names
            // State machine, execution, and activity names must be 1–80 characters in length,
            // must be unique for your account and region, and must not contain any of the following:
            // - Whitespace
            // - Wildcard characters (? *)
            // - Bracket characters (< > { } [ ])
            // - Special characters (: ; , \ | ^ ~ $ # % & ` ")
            // - Control characters (\\u0000 - \\u001f or \\u007f - \\u009f).
            .then(this.createEndpoints)
            .then(this.createStepFunctionsJSON),
    };
  }

  /**
   * For each statemachine, set up the appropriate endpoint resource to kick off
   * the execution of the state machine and generate a handler file for the endpoint
   * A custom request template is used to send the state machine name and starting
   * state's name to the lambda's execution
   */
  createEndpoints() {
      console.log('######### OFFLINE STEP FUNCTIONS - CREATING ENDPOINTS #########');

    const functions = this.serverless.service.functions;
    _.forEach(this.serverless.service.stepFunctions.stateMachines, (stateMachine, stateMachineName) => {
        _.forEach(stateMachine.definition.States, (state, stateName) => {
            if (state.Type === 'Task') {
                let lambdaName = this.serverless.providers.aws.naming.extractLambdaNameFromArn(state.Resource);

                // store the lambda function handler in the state for reference in the JSON file
                // it will be used to call the proper handler code when executing the fucntion
                // as part of the state machine
                if (this.serverless.service.custom &&
                    this.serverless.service.custom['serverless-offline-step-functions'] &&
                    this.serverless.service.custom['serverless-offline-step-functions'].resourcePrefix) {
                        const regex = new RegExp(this.serverless.service.custom['serverless-offline-step-functions'].resourcePrefix);
                        lambdaName = lambdaName.replace(regex, '');
                }

                if (!functions[lambdaName]) {
                    throw new Error(`Lambda function not found: ${lambdaName}`);
                }

                state.handler = functions[lambdaName].handler;
                if (stateName === stateMachine.definition.StartAt) {
                    // create a new function for an endpoint and
                    // give it a unique name
                    const newFn = {};
                    const functionName = `${lambdaName}-StepFunction${Date.now()}`;

                    // give the new function the same events as it's state machine twin
                    newFn.events = Object.assign([], stateMachine.events);

                    // set the handler to the generic state machine handler function
                    newFn.handler = `${this.handlersDirectory}/state-machine-handler.run`;
                    _.forEach(newFn.events, (event) => {
                        if (event.http) {
                            event.input = { stateName: stateMachine.definition.StartAt, stateMachine: stateMachineName };
                            event.http.integration = 'lambda';
                            event.http.request = {
                                headers: {
                                    'Content-type': 'application/json'
                                },
                                // this custom template copies (most of) the default template
                                // but also sends the state name and state machine name
                                // TODO: use a file, but need to figure out how to input
                                // TODO:  the stateName, stateMachine name into the file
                                template: {
                                    'application/json': `{
                                        "headers": "$input.params().header",
                                        "stateName": "${stateMachine.definition.StartAt}",
                                        "stateMachine": "${stateMachineName}",
                                        "pathParameters": "$input.params().path",
                                        "queryStringParameters": "$input.params().querystring",
                                        "body": $input.json('$')
                                    }`,
                                    },
                            };

                            // needed to include response headers otherwise sls offline threw an error:
                            // TypeError: Uncaught error: Cannot read property 'headers' of undefined
                            event.http.response = {
                                headers: {
                                    'Content-type': 'application/json',
                                },
                            };
                        }
                    });

                    // add to serverless functions
                    functions[functionName] = newFn;
                    // this.createRoute(functionName, newFn);
                    this.serverless.cli.log(`${this.logPrefix} created ${functionName}`);
                }
            }
        });
    });


  }

  /**
   * Creates a JSON file for reference during the state machine execution
   */
  createStepFunctionsJSON() {
    fs.writeFileSync(`${this.handlersDirectory}/step-functions.json`, JSON.stringify(this.serverless.service.stepFunctions));
  }

  /**
   * Adds the step function configuration to the serverless config
   * @author serverless-step-functions
   */
  parseYaml() {
    console.log('######### OFFLINE STEP FUNCTIONS - PARSING YAML #########');
    const servicePath = this.serverless.config.servicePath;
    if (!servicePath) {
        console.error(this.logPrefix, 'servicePath not found');
        return Promise.resolve();
    }

    const serverlessYmlPath = path.join(servicePath, 'serverless.yml');
    return this.serverless.yamlParser
    .parse(serverlessYmlPath)
    .then(serverlessFileParam => {
        this.serverless.service.stepFunctions = {};
        this.serverless.service.stepFunctions.stateMachines
            = serverlessFileParam.stepFunctions
        && serverlessFileParam.stepFunctions.stateMachines
            ? serverlessFileParam.stepFunctions.stateMachines : {};
        this.serverless.service.stepFunctions.activities
            = serverlessFileParam.stepFunctions
        && serverlessFileParam.stepFunctions.activities
            ? serverlessFileParam.stepFunctions.activities : [];

        if (!this.serverless.pluginManager.cliOptions.stage) {
            this.serverless.pluginManager.cliOptions.stage = this.options.stage ||
            (this.serverless.service.provider && this.serverless.service.provider.stage) ||
            'dev';
        }

        if (!this.serverless.pluginManager.cliOptions.region) {
        this.serverless.pluginManager.cliOptions.region = this.options.region ||
            (this.serverless.service.provider && this.serverless.service.provider.region) ||
            'us-east-1';
        }
        this.serverless.variables.populateService(this.serverless.pluginManager.cliOptions);
        return Promise.resolve();
    });
  }

  createRoute(lambdaName, newLambda) {
    const defaultContentType = 'application/json';
    const serviceRuntime = this.service.provider.runtime;
    const apiKeys = this.service.provider.apiKeys;
    const protectedRoutes = [];

    if (['nodejs', 'nodejs4.3', 'nodejs6.10', 'nodejs8.10', 'babel'].indexOf(serviceRuntime) === -1) {
      this.printBlankLine();
      this.serverlessLog(`Warning: found unsupported runtime '${serviceRuntime}'`);

      return;
    }

    // for simple API Key authentication model
    if (!_.isEmpty(apiKeys)) {
      this.serverlessLog(`Key with token: ${this.options.apiKey}`);

      if (this.options.noAuth) {
        this.serverlessLog('Authorizers are turned off. You do not need to use x-api-key header.');
      }
      else {
        this.serverlessLog('Remember to use x-api-key on the request headers');
      }
    }

    //   const fun = this.service.getFunction(lambdaName);
      const fun = newLambda;
      const funName = lambdaName;
      console.log('----- path', this.serverless.config.servicePath, this.options.location || '.');
      const servicePath = path.join(this.serverless.config.servicePath, this.options.location || '.');
      const funOptions = functionHelper.getFunctionOptions(fun, lambdaName, servicePath);
      console.log(`funOptions ${JSON.stringify(funOptions, null, 2)} `);

      this.printBlankLine();
      console.log(funName, 'runtime', serviceRuntime, funOptions.babelOptions || '');
      this.serverlessLog(`Routes for ${funName}:`);

      // Adds a route for each http endpoint
      (fun.events && fun.events.length || this.serverlessLog('(none)')) && fun.events.forEach(event => {
        if (!event.http) return this.serverlessLog('(none)');

        // Handle Simple http setup, ex. - http: GET users/index
        if (typeof event.http === 'string') {
          const split = event.http.split(' ');
          event.http = {
            path: split[1],
            method: split[0],
          };
        }

        // generate an enpoint via the endpoint class
        const endpoint = new Endpoint(event.http, funOptions).generate();

        let firstCall = true;

        const integration = endpoint.integration || 'lambda-proxy';
        const epath = endpoint.path;
        const method = endpoint.method.toUpperCase();
        const requestTemplates = endpoint.requestTemplates;

        // Prefix must start and end with '/' BUT path must not end with '/'
        let fullPath = this.options.prefix + (epath.startsWith('/') ? epath.slice(1) : epath);
        if (fullPath !== '/' && fullPath.endsWith('/')) fullPath = fullPath.slice(0, -1);
        fullPath = fullPath.replace(/\+}/g, '*}');

        if (_.eq(event.http.private, true)) {
          protectedRoutes.push(`${method}#${fullPath}`);
        }

        this.serverlessLog(`${method} ${fullPath}`);

        // If the endpoint has an authorization function, create an authStrategy for the route
        // TODO
        // const authStrategyName = this.options.noAuth ? null : this._configureAuthorization(endpoint, funName, method, epath, servicePath);
        const authStrategyName = null;

        let cors = null;
        if (endpoint.cors) {
          cors = {
            origin: endpoint.cors.origins || this.options.corsConfig.origin,
            headers: endpoint.cors.headers || this.options.corsConfig.headers,
            credentials: endpoint.cors.credentials || this.options.corsConfig.credentials,
            exposedHeaders: this.options.corsConfig.exposedHeaders,
          };
        }

        // Route creation
        const routeMethod = method === 'ANY' ? '*' : method;

        const state = this.options.disableCookieValidation ? {
          parse: false,
          failAction: 'ignore',
        } : {
          parse: true,
          failAction: 'error',
        };
        const routeConfig = {
          cors,
          auth: authStrategyName,
          timeout: { socket: false },
          state,
        };

        // skip HEAD routes as hapi will fail with 'Method name not allowed: HEAD ...'
        // for more details, check https://github.com/dherault/serverless-offline/issues/204
        if (routeMethod === 'HEAD') {
          this.serverlessLog('HEAD method event detected. Skipping HAPI server route mapping ...');

          return;
        }

        if (routeMethod !== 'HEAD' && routeMethod !== 'GET') {
          // maxBytes: Increase request size from 1MB default limit to 10MB.
          // Cf AWS API GW payload limits.
          routeConfig.payload = { parse: false, maxBytes: 1024 * 1024 * 10 };
        }

        console.log(Object.keys(this.offline));
        this.offline.server.route({
          method: routeMethod,
          path: fullPath,
          config: routeConfig,
          handler: (request, reply) => { // Here we go
            // Payload processing
            const encoding = utils.detectEncoding(request);

            request.payload = request.payload && request.payload.toString(encoding);
            request.rawPayload = request.payload;

            // Headers processing
            // Hapi lowercases the headers whereas AWS does not
            // so we recreate a custom headers object from the raw request
            const headersArray = request.raw.req.rawHeaders;

            // During tests, `server.inject` uses *shot*, a package
            // for performing injections that does not entirely mimick
            // Hapi's usual request object. rawHeaders are then missing
            // Hence the fallback for testing

            // Normal usage
            if (headersArray) {
              const unprocessedHeaders = {};
              request.multiValueHeaders = {};

              for (let i = 0; i < headersArray.length; i += 2) {
                unprocessedHeaders[headersArray[i]] = headersArray[i + 1];
                request.multiValueHeaders[headersArray[i]] =
                    (request.multiValueHeaders[headersArray[i]] || []).concat(headersArray[i + 1]);
              }

              request.unprocessedHeaders = unprocessedHeaders;
            }
            // Lib testing
            else {
              request.unprocessedHeaders = request.headers;
              // console.log('request.unprocessedHeaders:', request.unprocessedHeaders);
            }


            // Incomming request message
            this.printBlankLine();
            this.serverlessLog(`${method} ${request.path} (λ: ${funName})`);
            if (firstCall) {
              this.serverlessLog('The first request might take a few extra seconds');
              firstCall = false;
            }

            // this.serverlessLog(protectedRoutes);
            // Check for APIKey
            if ((_.includes(protectedRoutes, `${routeMethod}#${fullPath}`) || _.includes(protectedRoutes, `ANY#${fullPath}`)) && !this.options.noAuth) {
              const errorResponse = response => response({ message: 'Forbidden' }).code(403).type('application/json').header('x-amzn-ErrorType', 'ForbiddenException');
              if ('x-api-key' in request.headers) {
                const requestToken = request.headers['x-api-key'];
                if (requestToken !== this.options.apiKey) {
                  console.log(`Method ${method} of function ${funName} token ${requestToken} not valid`);

                  return errorResponse(reply);
                }
              }
              else if (request.auth && request.auth.credentials && 'usageIdentifierKey' in request.auth.credentials) {
                const usageIdentifierKey = request.auth.credentials.usageIdentifierKey;
                if (usageIdentifierKey !== this.options.apiKey) {
                  console.log(`Method ${method} of function ${funName} token ${usageIdentifierKey} not valid`);

                  return errorResponse(reply);
                }
              }
              else {
                console.log(`Missing x-api-key on private function ${funName}`);

                return errorResponse(reply);
              }
            }
            // Shared mutable state is the root of all evil they say
            const requestId = utils.randomId();
            this.requests[requestId] = { done: false };
            this.currentRequestId = requestId;

            // Holds the response to do async op
            const response = reply.response().hold();
            const contentType = request.mime || defaultContentType;

            // default request template to '' if we don't have a definition pushed in from serverless or endpoint
            const requestTemplate = typeof requestTemplates !== 'undefined' && integration === 'lambda' ? requestTemplates[contentType] : '';

            // https://hapijs.com/api#route-configuration doesn't seem to support selectively parsing
            // so we have to do it ourselves
            const contentTypesThatRequirePayloadParsing = ['application/json', 'application/vnd.api+json'];
            if (contentTypesThatRequirePayloadParsing.indexOf(contentType) !== -1) {
              try {
                request.payload = JSON.parse(request.payload);
              }
              catch (err) {
                console.log('error in converting request.payload to JSON:', err);
              }
            }

            console.log('requestId:', requestId);
            console.log('contentType:', contentType);
            console.log('requestTemplate:', requestTemplate);
            console.log('payload:', request.payload);

            /* HANDLER LAZY LOADING */

            let handler; // The lambda function
            Object.assign(process.env, this.originalEnvironment);

            try {
              if (this.options.noEnvironment) {
                // This evict errors in server when we use aws services like ssm
                const baseEnvironment = {
                  AWS_ACCESS_KEY_ID: 'dev',
                  AWS_SECRET_ACCESS_KEY: 'dev',
                  AWS_REGION: 'dev',
                };

                process.env = _.extend({}, baseEnvironment);
              }
              else {
                Object.assign(
                  process.env,
                  { AWS_REGION: this.service.provider.region },
                  this.service.provider.environment,
                  this.service.functions[key].environment
                );
              }
              process.env._HANDLER = fun.handler;
              handler = functionHelper.createHandler(funOptions, this.options);
            }
            catch (err) {
              return this._reply500(response, `Error while loading ${funName}`, err, requestId);
            }

            /* REQUEST TEMPLATE PROCESSING (event population) */

            let event = {};

            if (integration === 'lambda') {
              if (requestTemplate) {
                try {
                  console.log('_____ REQUEST TEMPLATE PROCESSING _____');
                  // Velocity templating language parsing
                  const velocityContext = createVelocityContext(request, this.velocityContextOptions, request.payload || {});
                  event = renderVelocityTemplateObject(requestTemplate, velocityContext);
                }
                catch (err) {
                  return this._reply500(response, `Error while parsing template "${contentType}" for ${funName}`, err, requestId);
                }
              }
              else if (typeof request.payload === 'object') {
                event = request.payload || {};
              }
            }
            else if (integration === 'lambda-proxy') {
              event = createLambdaProxyContext(request, this.options, this.velocityContextOptions.stageVariables);
            }

            event.isOffline = true;

            if (this.serverless.service.custom && this.serverless.service.custom.stageVariables) {
              event.stageVariables = this.serverless.service.custom.stageVariables;
            }
            else if (integration !== 'lambda-proxy') {
              event.stageVariables = {};
            }

            console.log('event:', event);

            // We create the context, its callback (context.done/succeed/fail) will send the HTTP response
            const lambdaContext = createLambdaContext(fun, (err, data, fromPromise) => {
              // Everything in this block happens once the lambda function has resolved
              console.log('_____ HANDLER RESOLVED _____');

              // Timeout clearing if needed
              if (this._clearTimeout(requestId)) return;

              // User should not call context.done twice
              if (this.requests[requestId].done) {
                this.printBlankLine();
                const warning = fromPromise
                  ? `Warning: handler '${funName}' returned a promise and also uses a callback!\nThis is problematic and might cause issues in your lambda.`
                  : `Warning: context.done called twice within handler '${funName}'!`;
                this.serverlessLog(warning);
                console.log('requestId:', requestId);

                return;
              }

              this.requests[requestId].done = true;

              let result = data;
              let responseName = 'default';
              const responseContentType = endpoint.responseContentType;
              const contentHandling = endpoint.contentHandling;

              /* RESPONSE SELECTION (among endpoint's possible responses) */

              // Failure handling
              let errorStatusCode = 0;
              if (err) {
                // Since the --useSeparateProcesses option loads the handler in
                // a separate process and serverless-offline communicates with it
                // over IPC, we are unable to catch JavaScript unhandledException errors
                // when the handler code contains bad JavaScript. Instead, we "catch"
                // it here and reply in the same way that we would have above when
                // we lazy-load the non-IPC handler function.
                if (this.options.useSeparateProcesses && err.ipcException) {
                  return this._reply500(response, `Error while loading ${funName}`, err, requestId);
                }

                const errorMessage = (err.message || err).toString();

                const re = /\[(\d{3})]/;
                const found = errorMessage.match(re);
                if (found && found.length > 1) {
                  errorStatusCode = found[1];
                }
                else {
                  errorStatusCode = '500';
                }

                // Mocks Lambda errors
                result = {
                  errorMessage,
                  errorType: err.constructor.name,
                  stackTrace: this._getArrayStackTrace(err.stack),
                };

                this.serverlessLog(`Failure: ${errorMessage}`);
                if (result.stackTrace) {
                  console.log(result.stackTrace.join('\n  '));
                }

                for (const key in endpoint.responses) {
                  if (key !== 'default' && errorMessage.match(`^${endpoint.responses[key].selectionPattern || key}$`)) {
                    responseName = key;
                    break;
                  }
                }
              }

              console.log(`Using response '${responseName}'`);
              const chosenResponse = endpoint.responses[responseName];

              /* RESPONSE PARAMETERS PROCCESSING */

              const responseParameters = chosenResponse.responseParameters;

              if (_.isPlainObject(responseParameters)) {

                const responseParametersKeys = Object.keys(responseParameters);

                console.log('_____ RESPONSE PARAMETERS PROCCESSING _____');
                console.log(`Found ${responseParametersKeys.length} responseParameters for '${responseName}' response`);

                responseParametersKeys.forEach(key => {

                  // responseParameters use the following shape: "key": "value"
                  const value = responseParameters[key];
                  const keyArray = key.split('.'); // eg: "method.response.header.location"
                  const valueArray = value.split('.'); // eg: "integration.response.body.redirect.url"

                  console.log(`Processing responseParameter "${key}": "${value}"`);

                  // For now the plugin only supports modifying headers
                  if (key.startsWith('method.response.header') && keyArray[3]) {

                    const headerName = keyArray.slice(3).join('.');
                    let headerValue;
                    console.log('Found header in left-hand:', headerName);

                    if (value.startsWith('integration.response')) {
                      if (valueArray[2] === 'body') {

                        console.log('Found body in right-hand');
                        headerValue = (valueArray[3] ? jsonPath(result, valueArray.slice(3).join('.')) : result).toString();

                      }
                      else {
                        this.printBlankLine();
                        this.serverlessLog(`Warning: while processing responseParameter "${key}": "${value}"`);
                        this.serverlessLog(`Offline plugin only supports "integration.response.body[.JSON_path]" right-hand responseParameter. Found "${value}" instead. Skipping.`);
                        this.logPluginIssue();
                        this.printBlankLine();
                      }
                    }
                    else {
                      headerValue = value.match(/^'.*'$/) ? value.slice(1, -1) : value; // See #34
                    }
                    // Applies the header;
                    console.log(`Will assign "${headerValue}" to header "${headerName}"`);
                    response.header(headerName, headerValue);

                  }
                  else {
                    this.printBlankLine();
                    this.serverlessLog(`Warning: while processing responseParameter "${key}": "${value}"`);
                    this.serverlessLog(`Offline plugin only supports "method.response.header.PARAM_NAME" left-hand responseParameter. Found "${key}" instead. Skipping.`);
                    this.logPluginIssue();
                    this.printBlankLine();
                  }
                });
              }

              let statusCode = 200;

              if (integration === 'lambda') {

                _(endpoint.response.headers)
                  .pickBy(isNestedString)
                  .mapValues(v => _.trim(v, '\''))
                  .forEach((v, k) => response.header(k, v));

                /* RESPONSE TEMPLATE PROCCESSING */
                // If there is a responseTemplate, we apply it to the result
                const responseTemplates = chosenResponse.responseTemplates;

                if (_.isPlainObject(responseTemplates)) {

                  const responseTemplatesKeys = Object.keys(responseTemplates);

                  if (responseTemplatesKeys.length) {

                    // BAD IMPLEMENTATION: first key in responseTemplates
                    const responseTemplate = responseTemplates[responseContentType];

                    if (responseTemplate && responseTemplate !== '\n') {

                      console.log('_____ RESPONSE TEMPLATE PROCCESSING _____');
                      console.log(`Using responseTemplate '${responseContentType}'`);

                      try {
                        const reponseContext = createVelocityContext(request, this.velocityContextOptions, result);
                        result = renderVelocityTemplateObject({ root: responseTemplate }, reponseContext).root;
                      }
                      catch (error) {
                        this.serverlessLog(`Error while parsing responseTemplate '${responseContentType}' for lambda ${funName}:`);
                        console.log(error.stack);
                      }
                    }
                  }
                }

                /* HAPIJS RESPONSE CONFIGURATION */

                statusCode = errorStatusCode !== 0 ? errorStatusCode : (chosenResponse.statusCode || 200);

                if (!chosenResponse.statusCode) {
                  this.printBlankLine();
                  this.serverlessLog(`Warning: No statusCode found for response "${responseName}".`);
                }

                response.header('Content-Type', responseContentType, {
                  override: false, // Maybe a responseParameter set it already. See #34
                });
                response.statusCode = statusCode;
                if (contentHandling === 'CONVERT_TO_BINARY') {
                  response.encoding = 'binary';
                  response.source = Buffer.from(result, 'base64');
                  response.variety = 'buffer';
                }
                else {
                  if (result.body && typeof result.body !== 'string') {
                    return this._reply500(response, 'According to the API Gateway specs, the body content must be stringified. Check your Lambda response and make sure you are invoking JSON.stringify(YOUR_CONTENT) on your body object', {}, requestId);
                  }
                  response.source = result;
                }
              }
              else if (integration === 'lambda-proxy') {
                response.statusCode = statusCode = result.statusCode || 200;

                const headers = {};
                if (result.headers) {
                  Object.keys(result.headers).forEach(header => {
                    headers[header] = (headers[header] || []).concat(result.headers[header]);
                  });
                }
                if (result.multiValueHeaders) {
                  Object.keys(result.multiValueHeaders).forEach(header => {
                    headers[header] = (headers[header] || []).concat(result.multiValueHeaders[header]);
                  });
                }

                console.log('headers', headers);
                Object.keys(headers).forEach(header => {
                  if (header.toLowerCase() === 'set-cookie') {
                    headers[header].forEach(headerValue => {
                      const cookieName = headerValue.slice(0, headerValue.indexOf('='));
                      const cookieValue = headerValue.slice(headerValue.indexOf('=') + 1);
                      reply.state(cookieName, cookieValue, { encoding: 'none', strictHeader: false });
                    });
                  }
                  else {
                    headers[header].forEach(headerValue => {
                      // it looks like Hapi doesn't support multiple headers with the same name,
                      // appending values is the closest we can come to the AWS behavior.
                      response.header(header, headerValue, { append: true });
                    });
                  }
                });
                response.header('Content-Type', 'application/json', { override: false, duplicate: false });

                if (!_.isUndefined(result.body)) {
                  if (result.isBase64Encoded) {
                    response.encoding = 'binary';
                    response.source = Buffer.from(result.body, 'base64');
                    response.variety = 'buffer';
                  }
                  else {
                    if (result.body && typeof result.body !== 'string') {
                      return this._reply500(response, 'According to the API Gateway specs, the body content must be stringified. Check your Lambda response and make sure you are invoking JSON.stringify(YOUR_CONTENT) on your body object', {}, requestId);
                    }
                    response.source = result.body;
                  }
                }
              }

              // Log response
              let whatToLog = result;

              try {
                whatToLog = JSON.stringify(result);
              }
              catch (error) {
                // nothing
              }
              finally {
                if (!this.options.dontPrintOutput) this.serverlessLog(err ? `Replying ${statusCode}` : `[${statusCode}] ${whatToLog}`);
                console.log('requestId:', requestId);
              }

              // Bon voyage!
              response.send();
            });

            // Now we are outside of createLambdaContext, so this happens before the handler gets called:

            // We cannot use Hapijs's timeout feature because the logic above can take a significant time, so we implement it ourselves
            this.requests[requestId].timeout = this.options.noTimeout ? null : setTimeout(
              this._replyTimeout.bind(this, response, funName, funOptions.funTimeout, requestId),
              funOptions.funTimeout
            );

            // Finally we call the handler
            console.log('_____ CALLING HANDLER _____');
            try {
              const x = handler(event, lambdaContext, lambdaContext.done);

              // Promise support
              if ((serviceRuntime === 'nodejs8.10' || serviceRuntime === 'babel') && !this.requests[requestId].done) {
                if (x && typeof x.then === 'function' && typeof x.catch === 'function') x.then(lambdaContext.succeed).catch(lambdaContext.fail);
                else if (x instanceof Error) lambdaContext.fail(x);
              }
            }
            catch (error) {
              return this._reply500(response, `Uncaught error in your '${funName}' handler`, error, requestId);
            }
          },
        });
      });
  }

  printBlankLine() {
      console.log();
  }
}

module.exports = ServerlessPlugin;

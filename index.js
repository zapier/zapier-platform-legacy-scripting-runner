const _ = require('lodash');
const FormData = require('form-data');

const cleaner = require('zapier-platform-core/src/tools/cleaner');

const bundleConverter = require('./bundle');
const {
  markFileFieldsInBundle,
  hasFileFields,
  isFileField,
  LazyFile
} = require('./file');

const FIELD_TYPE_CONVERT_MAP = {
  // field_type_in_wb: field_type_in_cli
  bool: 'boolean',
  copy: 'copy',
  datetime: 'datetime',
  dict: 'string',
  file: 'file',
  float: 'number',
  int: 'integer',
  password: 'password',
  text: 'text',
  unicode: 'string'
};

const parseFinalResult = async (result, event) => {
  if (event.name.endsWith('.pre')) {
    if (!_.isEmpty(result.files)) {
      const formData = new FormData();
      formData.append('data', result.data || '{}');

      const fileFieldKeys = Object.keys(result.files);
      const lazyFiles = fileFieldKeys.map(k => {
        const file = result.files[k];
        let lazyFile;
        if (Array.isArray(file) && file.length === 3) {
          const [filename, newFileValue, contentType] = file;
          // If pre_write changes the hydrate URL, file[1], we take it as a
          // string content even if it looks like a URL
          const loadUrls = newFileValue === event.originalFiles[k][1];
          lazyFile = LazyFile(
            newFileValue,
            { filename, contentType },
            { dontLoadUrls: !loadUrls }
          );
        } else if (typeof file === 'string') {
          lazyFile = LazyFile(file);
        }
        return lazyFile;
      });
      const fileMetas = await Promise.all(lazyFiles.map(f => f && f.meta()));
      const fileStreams = await Promise.all(
        lazyFiles.map(f => f && f.readStream())
      );

      _.zip(fileFieldKeys, fileMetas, fileStreams).forEach(
        ([k, meta, fileStream]) => {
          if (meta && fileStream) {
            formData.append(k, fileStream, meta);
          }
        }
      );

      result.body = formData;
      return result;
    }

    // Old request was .data (string), new is .body (object), which matters for _pre
    try {
      result.body = JSON.parse(result.data || '{}');
    } catch (e) {
      result.body = result.data;
    }
    return Promise.resolve(result);
  }

  // Old writes accepted a list, but CLI doesn't anymore, which matters for _write and _post_write
  if (event.name === 'create.write' || event.name === 'create.post') {
    let resultObj;
    if (Array.isArray(result) && result.length) {
      resultObj = result[0];
    } else if (!Array.isArray(result)) {
      resultObj = result;
    } else {
      resultObj = {};
    }
    return Promise.resolve(resultObj);
  }

  if (
    event.name.endsWith('.input') ||
    event.name.endsWith('.output') ||
    event.name.endsWith('.input.post') ||
    event.name.endsWith('.output.post')
  ) {
    if (Array.isArray(result)) {
      result.forEach(field => {
        field.type = FIELD_TYPE_CONVERT_MAP[field.type] || field.type;
      });
    }
  }

  return Promise.resolve(result);
};

const replaceCurliesInRequest = (request, bundle) => {
  const bank = cleaner.createBundleBank(undefined, { bundle: bundle });
  return cleaner.recurseReplaceBank(request, bank);
};

const compileLegacyScriptingSource = source => {
  const { DOMParser, XMLSerializer } = require('xmldom');
  const {
    ErrorException,
    HaltedException,
    StopRequestException,
    ExpiredAuthException,
    RefreshTokenException,
    InvalidSessionException
  } = require('./exceptions');

  return new Function( // eslint-disable-line no-new-func
    '_',
    'crypto',
    'async',
    'moment',
    'DOMParser',
    'XMLSerializer',
    'atob',
    'btoa',
    'z',
    '$',
    'ErrorException',
    'HaltedException',
    'StopRequestException',
    'ExpiredAuthException',
    'RefreshTokenException',
    'InvalidSessionException',
    source + '\nreturn Zap;'
  )(
    _,
    require('crypto'),
    require('async'),
    require('moment-timezone'),
    DOMParser,
    XMLSerializer,
    require('./atob'),
    require('./btoa'),
    require('./z'),
    require('./$'),
    ErrorException,
    HaltedException,
    StopRequestException,
    ExpiredAuthException,
    RefreshTokenException,
    InvalidSessionException
  );
};

const applyBeforeMiddleware = (befores, request, z, bundle) => {
  befores = befores || [];
  return befores.reduce(
    (prev, cur) => prev.then(req => cur(req, z, bundle)),
    Promise.resolve(request)
  );
};

const createEventNameToMethodMapping = key => {
  return {
    //
    // Auth
    //
    'auth.session': 'get_session_info',
    'auth.connectionLabel': 'get_connection_label',
    'auth.oauth2.token.pre': 'pre_oauthv2_token',
    'auth.oauth2.token.post': 'post_oauthv2_token',
    'auth.oauth2.refresh.pre': 'pre_oauthv2_refresh',

    //
    // Triggers
    //
    'trigger.poll': `${key}_poll`,
    'trigger.pre': `${key}_pre_poll`,
    'trigger.post': `${key}_post_poll`,
    'trigger.hook': `${key}_catch_hook`,
    'trigger.hook.pre': `${key}_pre_hook`,
    'trigger.hook.post': `${key}_post_hook`,
    'trigger.hook.subscribe.pre': 'pre_subscribe',
    'trigger.hook.subscribe.post': 'post_subscribe',
    'trigger.hook.unsubscribe.pre': 'pre_unsubscribe',
    'trigger.output.pre': `${key}_pre_custom_trigger_fields`,
    'trigger.output.post': `${key}_post_custom_trigger_fields`,

    //
    // Creates
    //
    'create.write': `${key}_write`,
    'create.pre': `${key}_pre_write`,
    'create.post': `${key}_post_write`,
    'create.input': `${key}_custom_action_fields`,
    'create.input.pre': `${key}_pre_custom_action_fields`,
    'create.input.post': `${key}_post_custom_action_fields`,
    'create.output': `${key}_custom_action_result_fields`,
    'create.output.pre': `${key}_pre_custom_action_result_fields`,
    'create.output.post': `${key}_post_custom_action_result_fields`,

    //
    // Searches
    //
    'search.search': `${key}_search`,
    'search.pre': `${key}_pre_search`,
    'search.post': `${key}_post_search`,
    'search.resource': `${key}_read_resource`,
    'search.resource.pre': `${key}_pre_read_resource`,
    'search.resource.post': `${key}_post_read_resource`,
    'search.input': `${key}_custom_search_fields`,
    'search.input.pre': `${key}_pre_custom_search_fields`,
    'search.input.post': `${key}_post_custom_search_fields`,
    'search.output': `${key}_custom_search_result_fields`,
    'search.output.pre': `${key}_pre_custom_search_result_fields`,
    'search.output.post': `${key}_post_custom_search_result_fields`
  };
};

const legacyScriptingRunner = (Zap, zobj, app) => {
  if (typeof Zap === 'string') {
    Zap = compileLegacyScriptingSource(Zap);
  }

  // Does string replacement ala WB, using bundle and a potential result object
  const replaceVars = (templateString, bundle, result) => {
    const options = {
      interpolate: /{{([\s\S]+?)}}/g
    };
    const values = _.extend({}, bundle.authData, bundle.inputData, result);
    return _.template(templateString, options)(values);
  };

  const runEvent = (event, z, bundle) =>
    new Promise((resolve, reject) => {
      if (!Zap || _.isEmpty(Zap) || !event || !event.name || !z) {
        resolve();
        return;
      }

      bundleConverter(bundle, event, z).then(convertedBundle => {
        const eventNameToMethod = createEventNameToMethodMapping(event.key);
        const methodName = eventNameToMethod[event.name];

        if (methodName && _.isFunction(Zap[methodName])) {
          // Handle async
          const optionalCallback = (err, asyncResult) => {
            if (err) {
              reject(err);
            } else {
              parseFinalResult(asyncResult, event).then(res => {
                resolve(res);
              });
            }
          };

          // To know if request.files is changed by scripting
          event.originalFiles = _.cloneDeep(
            _.get(convertedBundle, 'request.files') || {}
          );

          let result;
          try {
            result = Zap[methodName](convertedBundle, optionalCallback);
          } catch (err) {
            reject(err);
          }

          // Handle sync
          if (result !== undefined) {
            parseFinalResult(result, event).then(res => {
              resolve(res);
            });
          }
        } else {
          resolve({});
        }
      });
    });

  // Simulates how WB backend runs JS scripting methods
  const runEventCombo = async (
    bundle,
    key,
    preEventName,
    postEventName,
    fullEventName,
    options
  ) => {
    options = _.extend(
      {
        // Options to deal with the final result returned by this function.
        // * checkResponseStatus: throws an error if response status is not 2xx.
        // * parseResponse:
        //     assumes response content is JSON and parse it. post method won't
        //     run if this is false.
        // * ensureArray: could be one of the following values:
        //   - false:
        //       returns whatever data parsed from response content or returned
        //       by the post method.
        //   - 'wrap': returns [result] if result is an object.
        //   - 'first':
        //       returns the first top-level array in the result if result
        //       is an object. This is the fallback behavior if ensureArray is
        //       not false nor 'wrap'.
        checkResponseStatus: true,
        parseResponse: true,
        ensureArray: false,

        resetRequestForFullMethod: false
      },
      options
    );

    if (bundle.request) {
      bundle.request = replaceCurliesInRequest(bundle.request, bundle);
    }

    let result;

    const eventNameToMethod = createEventNameToMethodMapping(key);

    const preMethodName = preEventName ? eventNameToMethod[preEventName] : null;
    const postMethodName = postEventName
      ? eventNameToMethod[postEventName]
      : null;
    const fullMethodName = fullEventName
      ? eventNameToMethod[fullEventName]
      : null;

    const fullMethod = fullMethodName ? Zap[fullMethodName] : null;
    if (fullMethod) {
      if (options.resetRequestForFullMethod) {
        // Used by custom fields
        _.extend(bundle.request, {
          method: 'GET',
          url: ''
        });
      }

      // Running "full" scripting method like KEY_poll
      result = await runEvent({ key, name: fullEventName }, zobj, bundle);
    } else {
      const preMethod = preMethodName ? Zap[preMethodName] : null;
      const request = preMethod
        ? await runEvent({ key, name: preEventName }, zobj, bundle)
        : bundle.request;

      const isBodyStream = typeof _.get(request, 'body.pipe') === 'function';

      if (hasFileFields(bundle) && !isBodyStream) {
        const data = {};
        const fileFieldKeys = [];
        const lazyFiles = [];

        _.each(request.body, (v, k) => {
          if (!isFileField(k, bundle)) {
            data[k] = v;
          } else if (typeof v === 'string') {
            fileFieldKeys.push(k);
            lazyFiles.push(LazyFile(v));
          }
        });

        const fileMetas = await Promise.all(lazyFiles.map(f => f.meta()));
        const fileStreams = await Promise.all(
          lazyFiles.map(f => f.readStream())
        );

        const formData = new FormData();
        formData.append('data', JSON.stringify(data));

        _.zip(fileFieldKeys, fileMetas, fileStreams).forEach(
          ([k, meta, fileStream]) => {
            formData.append(k, fileStream, meta);
          }
        );

        request.body = formData;
      }

      const response = await zobj.request(request);

      if (options.checkResponseStatus) {
        response.throwForStatus();
      }

      if (!options.parseResponse) {
        return response;
      }

      const postMethod = postMethodName ? Zap[postMethodName] : null;
      result = postMethod
        ? await runEvent({ key, name: postEventName, response }, zobj, bundle)
        : zobj.JSON.parse(response.content);
    }

    if (options.ensureArray) {
      if (Array.isArray(result)) {
        return result;
      } else if (result && typeof result === 'object') {
        if (options.ensureArray === 'wrap') {
          // Used by auth label and auth test
          return [result];
        } else {
          // Find the first array in the response
          for (const k in result) {
            const value = result[k];
            if (Array.isArray(value)) {
              return value;
            }
          }
        }
      }
      throw new Error('JSON results array could not be located.');
    }

    return result;
  };

  const runOAuth2GetAccessToken = bundle => {
    const url = _.get(
      app,
      'authentication.oauth2Config.legacyProperties.accessTokenUrl'
    );

    const request = bundle.request;
    request.method = 'POST';
    request.url = url;
    request.headers['Content-Type'] = 'application/json';

    const body = request.body;
    body.code = bundle.inputData.code;
    body.client_id = process.env.CLIENT_ID;
    body.client_secret = process.env.CLIENT_SECRET;
    body.redirect_uri = bundle.inputData.redirect_uri;
    body.grant_type = 'authorization_code';

    return runEventCombo(
      bundle,
      '',
      'auth.oauth2.token.pre',
      'auth.oauth2.token.post'
    );
  };

  const runOAuth2RefreshAccessToken = bundle => {
    const url = _.get(
      app,
      'authentication.oauth2Config.legacyProperties.refreshTokenUrl'
    );

    const request = bundle.request;
    request.method = 'POST';
    request.url = url;
    request.headers['Content-Type'] = 'application/json';

    const body = request.body;
    body.client_id = process.env.CLIENT_ID;
    body.client_secret = process.env.CLIENT_SECRET;
    body.refresh_token = bundle.authData.refresh_token;
    body.grant_type = 'refresh_token';

    return runEventCombo(bundle, '', 'auth.oauth2.refresh.pre');
  };

  const runTrigger = (bundle, key) => {
    const url = _.get(app, `triggers.${key}.operation.legacyProperties.url`);
    bundle.request.url = url;

    // For auth test we wrap the resposne as an array if it isn't one
    const ensureArray = _.get(bundle, 'meta.test_poll') ? 'wrap' : 'first';

    return runEventCombo(
      bundle,
      key,
      'trigger.pre',
      'trigger.post',
      'trigger.poll',
      { ensureArray }
    );
  };

  const runCatchHook = (bundle, key) => {
    const methodName = `${key}_catch_hook`;
    const promise = Zap[methodName]
      ? runEvent({ key, name: 'trigger.hook' }, zobj, bundle)
      : Promise.resolve(bundle.cleanedRequest);
    return promise.then(result => {
      if (!Array.isArray(result)) {
        result = [result];
      }
      return result;
    });
  };

  const runPrePostHook = (bundle, key) => {
    return runEventCombo(bundle, key, 'trigger.hook.pre', 'trigger.hook.post');
  };

  const runHook = (bundle, key) => {
    const hookType = _.get(
      app,
      `triggers.${key}.operation.legacyProperties.hookType`
    );

    let cleanedArray;
    if (Array.isArray(bundle.cleanedRequest)) {
      cleanedArray = bundle.cleanedRequest;
    } else if (
      bundle.cleanedRequest &&
      typeof bundle.cleanedRequest === 'object'
    ) {
      cleanedArray = [bundle.cleanedRequest];
    }

    const shouldRunPrePostHook =
      hookType === 'notification' &&
      cleanedArray &&
      cleanedArray.every(x => x.resource_url);

    if (shouldRunPrePostHook) {
      const promises = cleanedArray.map(obj => {
        const bund = _.cloneDeep(bundle);
        bund.request.url = obj.resource_url;
        return runPrePostHook(bund, key);
      });
      return Promise.all(promises).then(_.flatten);
    }

    return runCatchHook(bundle, key);
  };

  const runHookSubscribe = (bundle, key) => {
    const url = _.get(app, 'legacyProperties.subscribeUrl');
    const event = _.get(
      app,
      `triggers.${key}.operation.legacyProperties.event`
    );

    const request = bundle.request;
    request.method = 'POST';
    request.url = url;

    const body = request.body;
    body.subscription_url = bundle.targetUrl; // backward compatibility
    body.target_url = bundle.targetUrl;
    body.event = event;

    return runEventCombo(
      bundle,
      key,
      'trigger.hook.subscribe.pre',
      'trigger.hook.subscribe.post'
    );
  };

  const runHookUnsubscribe = (bundle, key) => {
    const url = _.get(app, 'legacyProperties.unsubscribeUrl');
    const event = _.get(
      app,
      `triggers.${key}.operation.legacyProperties.event`
    );

    const request = bundle.request;
    request.method = 'POST';
    request.url = url;

    const body = request.body;
    body.subscription_url = bundle.targetUrl; // backward compatibility
    body.target_url = bundle.targetUrl;
    body.event = event;

    return runEventCombo(
      bundle,
      key,
      'trigger.hook.unsubscribe.pre',
      undefined,
      undefined,
      { parseResponse: false }
    );
  };

  const runCustomFields = (
    bundle,
    key,
    typeOf,
    url,
    supportFullMethod = true
  ) => {
    let preEventName, postEventName, fullEventName;
    if (url) {
      preEventName = typeOf + '.pre';
      postEventName = typeOf + '.post';
      bundle.request.url = url;
    }

    if (supportFullMethod) {
      fullEventName = typeOf;
    }

    bundle.request.method = 'GET';

    return runEventCombo(
      bundle,
      key,
      preEventName,
      postEventName,
      fullEventName,
      { ensureArray: 'wrap', resetRequestForFullMethod: true }
    );
  };

  const runTriggerOutputFields = (bundle, key) => {
    const url = _.get(
      app,
      `triggers.${key}.operation.legacyProperties.outputFieldsUrl`
    );
    return runCustomFields(bundle, key, 'trigger.output', url, false);
  };

  const runCreate = (bundle, key) => {
    const legacyProps =
      _.get(app, `creates.${key}.operation.legacyProperties`) || {};
    const url = legacyProps.url;
    const fieldsExcludedFromBody = legacyProps.fieldsExcludedFromBody || [];

    const inputFields =
      _.get(app, `creates.${key}.operation.inputFields`) || [];

    markFileFieldsInBundle(bundle, inputFields);

    const body = {};
    _.each(bundle.inputData, (v, k) => {
      if (fieldsExcludedFromBody.indexOf(k) === -1) {
        body[k] = v;
      }
    });

    bundle.request.method = 'POST';
    bundle.request.url = url;
    bundle.request.body = body;

    return runEventCombo(
      bundle,
      key,
      'create.pre',
      'create.post',
      'create.write'
    );
  };

  const runCreateInputFields = (bundle, key) => {
    const url = _.get(
      app,
      `creates.${key}.operation.legacyProperties.inputFieldsUrl`
    );
    return runCustomFields(bundle, key, 'create.input', url);
  };

  const runCreateOutputFields = (bundle, key) => {
    const url = _.get(
      app,
      `creates.${key}.operation.legacyProperties.outputFieldsUrl`
    );
    return runCustomFields(bundle, key, 'create.output', url);
  };

  const runSearch = (bundle, key) => {
    const url = _.get(app, `searches.${key}.operation.legacyProperties.url`);

    bundle.request.url = url;

    return runEventCombo(
      bundle,
      key,
      'search.pre',
      'search.post',
      'search.search',
      { ensureArray: 'first' }
    );
  };

  const runSearchResource = (bundle, key) => {
    const url = _.get(
      app,
      `searches.${key}.operation.legacyProperties.resourceUrl`
    );
    bundle.request.url = url;

    return runEventCombo(
      bundle,
      key,
      'search.resource.pre',
      'search.resource.post',
      'search.resource',
      { parseResponseForPostMethod: true }
    );
  };

  const runSearchInputFields = (bundle, key) => {
    const url = _.get(
      app,
      `searches.${key}.operation.legacyProperties.inputFieldsUrl`
    );
    return runCustomFields(bundle, key, 'search.input', url);
  };

  const runSearchOutputFields = (bundle, key) => {
    const url = _.get(
      app,
      `searches.${key}.operation.legacyProperties.outputFieldsUrl`
    );
    return runCustomFields(bundle, key, 'search.output', url);
  };

  // core exposes this function as z.legacyScripting.run() method that we can
  // run legacy scripting easily like z.legacyScripting.run(bundle, 'trigger', 'KEY')
  // in CLI to simulate how WB backend runs legacy scripting.
  const run = (bundle, typeOf, key) => {
    const initRequest = {
      url: '',
      headers: {},
      params: {},
      body: {}
    };
    return applyBeforeMiddleware(
      app.beforeRequest,
      initRequest,
      zobj,
      bundle
    ).then(preparedRequest => {
      bundle.request = preparedRequest;

      switch (typeOf) {
        case 'auth.session':
          return runEvent({ name: 'auth.session' }, zobj, bundle);
        case 'auth.connectionLabel':
          return runEvent({ name: 'auth.connectionLabel' }, zobj, bundle);
        case 'auth.oauth2.token':
          return runOAuth2GetAccessToken(bundle);
        case 'auth.oauth2.refresh':
          return runOAuth2RefreshAccessToken(bundle);
        case 'trigger':
          return runTrigger(bundle, key);
        case 'trigger.hook':
          return runHook(bundle, key);
        case 'trigger.hook.subscribe':
          return runHookSubscribe(bundle, key);
        case 'trigger.hook.unsubscribe':
          return runHookUnsubscribe(bundle, key);
        case 'trigger.output':
          return runTriggerOutputFields(bundle, key);
        case 'create':
          return runCreate(bundle, key);
        case 'create.input':
          return runCreateInputFields(bundle, key);
        case 'create.output':
          return runCreateOutputFields(bundle, key);
        case 'search':
          return runSearch(bundle, key);
        case 'search.resource':
          return runSearchResource(bundle, key);
        case 'search.input':
          return runSearchInputFields(bundle, key);
        case 'search.output':
          return runSearchOutputFields(bundle, key);
      }
      throw new Error(`unrecognizable typeOf '${typeOf}'`);
    });
  };

  return {
    run,
    runEvent,
    replaceVars
  };
};

module.exports = legacyScriptingRunner;

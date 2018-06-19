'use strict';

const _ = require('lodash');

const bundleConverter = require('./bundle');

const parseFinalResult = (result, event) => {
  // Old request was .data (string), new is .body (object), which matters for _pre
  if (event.name.endsWith('.pre')) {
    try {
      result.body = JSON.parse(result.data || '{}');
    } catch (e) {
      result.body = result.data;
    }
  }

  // Old writes accepted a list, but CLI doesn't anymore, which matters for _write and _post_write
  if (event.name === 'create.write' || event.name === 'create.post') {
    if (_.isArray(result) && result.length) {
      return result[0];
    } else if (!_.isArray(result)) {
      return result;
    }

    return {};
  }

  return result;
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
        return resolve();
      }

      const convertedBundle = bundleConverter(bundle, event);

      const eventNameToMethod = {
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
        'trigger.poll': `${event.key}_poll`,
        'trigger.pre': `${event.key}_pre_poll`,
        'trigger.post': `${event.key}_post_poll`,
        'trigger.hook': `${event.key}_catch_hook`,
        'trigger.hook.pre': `${event.key}_pre_hook`,
        'trigger.hook.post': `${event.key}_post_hook`,
        'trigger.hook.subscribe.pre': 'pre_subscribe',
        'trigger.hook.subscribe.post': 'post_subscribe',
        'trigger.hook.unsubscribe.pre': 'pre_unsubscribe',
        'trigger.output.pre': `${event.key}_pre_custom_trigger_fields`,
        'trigger.output.post': `${event.key}_post_custom_trigger_fields`,

        //
        // Creates
        //
        'create.write': `${event.key}_write`,
        'create.pre': `${event.key}_pre_write`,
        'create.post': `${event.key}_post_write`,
        'create.input': `${event.key}_custom_action_fields`,
        'create.input.pre': `${event.key}_pre_custom_action_fields`,
        'create.input.post': `${event.key}_post_custom_action_fields`,
        'create.output': `${event.key}_custom_action_result_fields`,
        'create.output.pre': `${event.key}_pre_custom_action_result_fields`,
        'create.output.post': `${event.key}_post_custom_action_result_fields`,

        //
        // Searches
        //
        'search.search': `${event.key}_search`,
        'search.pre': `${event.key}_pre_search`,
        'search.post': `${event.key}_post_search`,
        'search.resource': `${event.key}_read_resource`,
        'search.resource.pre': `${event.key}_pre_read_resource`,
        'search.resource.post': `${event.key}_post_read_resource`,
        'search.input': `${event.key}_custom_search_fields`,
        'search.input.pre': `${event.key}_pre_custom_search_fields`,
        'search.input.post': `${event.key}_post_custom_search_fields`,
        'search.output': `${event.key}_custom_search_result_fields`,
        'search.output.pre': `${event.key}_pre_custom_search_result_fields`,
        'search.output.post': `${event.key}_post_custom_search_result_fields`
      };

      const methodName = eventNameToMethod[event.name];

      if (methodName && _.isFunction(Zap[methodName])) {
        let result;

        try {
          // Handle async
          const optionalCallback = (error, asyncResult) => {
            if (error) {
              return reject(error);
            }
            return resolve(parseFinalResult(asyncResult, event));
          };

          result = Zap[methodName](convertedBundle, optionalCallback);

          // Handle sync
          if (typeof result !== 'undefined') {
            return resolve(parseFinalResult(result, event));
          }
        } catch (e) {
          return reject(e);
        }
      } else {
        return resolve({});
      }

      return undefined;
    });

  const runOAuth2GetAccessToken = bundle => {
    let promise = null;
    const funcs = [];

    bundle._legacyUrl = _.get(
      app,
      'authentication.oauth2Config.legacyProperties.accessTokenUrl'
    );
    bundle._legacyUrl = replaceVars(bundle._legacyUrl, bundle);
    bundle.request = {
      method: 'POST',
      url: bundle._legacyUrl,
      body: {
        code: bundle.inputData.code,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        redirect_uri: bundle.inputData.redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const preMethod = Zap.pre_oauthv2_token;
    if (preMethod) {
      promise = runEvent({ name: 'auth.oauth2.token.pre' }, zobj, bundle);
    } else {
      promise = Promise.resolve(bundle.request);
    }

    funcs.push(request => {
      return zobj.request(request);
    });

    const postMethod = Zap.post_oauthv2_token;
    if (postMethod) {
      funcs.push(response => {
        response.throwForStatus();
        return runEvent(
          { name: 'auth.oauth2.token.post', response },
          zobj,
          bundle
        );
      });
    } else {
      funcs.push(response => {
        response.throwForStatus();
        return zobj.JSON.parse(response.content);
      });
    }

    // Equivalent to promise.then(funcs[0]).then(funcs[1])...
    return funcs.reduce((prev, cur) => prev.then(cur), promise);
  };

  const runOAuth2RefreshAccessToken = bundle => {
    bundle._legacyUrl = _.get(
      app,
      'authentication.oauth2Config.legacyProperties.refreshTokenUrl'
    );
    bundle._legacyUrl = replaceVars(bundle._legacyUrl, bundle);
    bundle.request = {
      method: 'POST',
      url: bundle._legacyUrl,
      body: {
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        refresh_token: bundle.authData.refresh_token,
        grant_type: 'refresh_token'
      },
      headers: {
        'Content-Type': 'application/json'
      }
    };

    let promise;
    const preMethod = Zap.pre_oauthv2_token;
    if (preMethod) {
      promise = runEvent({ name: 'auth.oauth2.refresh.pre' }, zobj, bundle);
    } else {
      promise = Promise.resolve(bundle.request);
    }

    return promise.then(request => zobj.request(request)).then(response => {
      response.throwForStatus();
      return zobj.JSON.parse(response.content);
    });
  };

  const runTrigger = (bundle, key) => {
    let promise = null;
    const funcs = [];

    bundle._legacyUrl = _.get(
      app,
      `triggers.${key}.operation.legacyProperties.url`
    );
    bundle._legacyUrl = replaceVars(bundle._legacyUrl, bundle);

    const fullMethod = Zap[`${key}_poll`];
    if (fullMethod) {
      promise = runEvent({ key, name: 'trigger.poll' }, zobj, bundle);
    } else {
      const preMethod = Zap[`${key}_pre_poll`];
      if (preMethod) {
        promise = runEvent({ key, name: 'trigger.pre' }, zobj, bundle);
      } else {
        promise = Promise.resolve({
          url: bundle._legacyUrl
        });
      }

      funcs.push(request => {
        return zobj.request(request);
      });

      const postMethod = Zap[`${key}_post_poll`];
      if (postMethod) {
        funcs.push(response => {
          response.throwForStatus();
          return runEvent(
            { key, name: 'trigger.post', response },
            zobj,
            bundle
          );
        });
      } else {
        funcs.push(response => {
          response.throwForStatus();
          return zobj.JSON.parse(response.content);
        });
      }
    }

    // Equivalent to promise.then(funcs[0]).then(funcs[1])...
    return funcs.reduce((prev, cur) => prev.then(cur), promise);
  };

  // Simulates how backend run legacy scripting. core exposes this as
  // z.legacyScripting.run() method that we can run legacy scripting easily
  // like z.legacyScripting.run(bundle, 'trigger', 'KEY') in CLI.
  const run = (bundle, typeOf, key) => {
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
    }

    // TODO: auth, create, and search
    return Promise.resolve();
  };

  return {
    run,
    runEvent,
    replaceVars
  };
};

module.exports = legacyScriptingRunner;

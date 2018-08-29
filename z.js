const crypto = require('crypto');

const _ = require('lodash');
const deasync = require('deasync');
const request = require('request');

const exceptions = require('./exceptions');

// Converts WB `bundle.request` format to something `request` can use
const convertBundleRequest = bundleOrBundleRequest => {
  bundleOrBundleRequest = _.extend({}, bundleOrBundleRequest);

  // LEGACY: allow for the whole bundle to mistakingly be sent over
  const bundleRequest = bundleOrBundleRequest.request
    ? bundleOrBundleRequest.request
    : bundleOrBundleRequest;

  let auth = null;

  if (
    bundleRequest.auth &&
    _.isArray(bundleRequest.auth) &&
    bundleRequest.auth.length === 2
  ) {
    auth = {
      user: bundleRequest.auth[0],
      password: bundleRequest.auth[1]
    };
  }

  bundleRequest.qs = bundleRequest.params || {};
  bundleRequest.auth = auth;
  bundleRequest.body = bundleRequest.data || '';

  delete bundleRequest.params;
  delete bundleRequest.data;

  return bundleRequest;
};

const parseBody = body => {
  if (body) {
    if (typeof body === 'string' || body.writeInt32BE) {
      return String(body);
    }

    return body;
  }

  return null;
};

// Converts `request`'s response into a simplified object
const convertResponse = response => {
  if (response) {
    return {
      status_code: response.statusCode,
      headers: _.extend({}, response.headers),
      content: parseBody(response.body)
    };
  }

  return {};
};

const syncRequest = deasync(request);

const z = {
  AWS: () => {
    // Direct require breaks the build as the module isn't found by browserify
    const moduleName = 'aws-sdk';
    return require(moduleName);
  },

  JSON: {
    parse: str => {
      try {
        return JSON.parse(str);
      } catch (err) {
        let preview = str;

        if (str && str.length > 100) {
          preview = str.substr(0, 100);
        }

        throw new Error(`Error parsing response. We got: "${preview}"`);
      }
    },

    stringify: str => {
      try {
        return JSON.stringify(str);
      } catch (err) {
        throw new Error(err.message);
      }
    }
  },

  request: (bundleRequest, callback) => {
    const options = convertBundleRequest(bundleRequest);

    if (_.isFunction(callback)) {
      return request(options, (err, response) =>
        callback(err, convertResponse(response))
      );
    }

    const response = syncRequest(options);
    return convertResponse(response);
  },

  hash: (algorithm, string, encoding = 'hex', inputEncoding = 'binary') => {
    const hasher = crypto.createHash(algorithm);
    hasher.update(string, inputEncoding);

    return hasher.digest(encoding);
  },

  hmac: (algorithm, key, string, encoding = 'hex') => {
    const hasher = crypto.createHash(algorithm, key);
    hasher.update(string);

    return hasher.digest(encoding);
  },

  snipify: string => {
    const SALT = process.env.SECRET_SALT || 'doesntmatterreally';
    if (!_.isString(string)) {
      return null;
    }

    const length = string.length;
    string += SALT;
    const result = z.hash('sha256', string);

    return `:censored:${length}:${result.substr(0, 10)}:`;
  },

  dehydrate: (method, bundle) => {
    method = method || undefined;
    bundle = bundle || {};

    if (typeof method !== 'string') {
      throw new exceptions.DehydrateException(
        'The provided method name is not a string!'
      );
    }

    // The original hydrator that does the actual work (hydrators._legacyHydrateMethod
    // is just a proxy that calls the original). Expecting an existing method name in
    // Zap object. Put it in bundle so legacy-scripting-runner knows where to locate and
    // call the hydrator later.
    bundle._originalHydrateMethodName = method;

    return (
      'hydrate|||' +
      JSON.stringify({
        type: 'method',
        method: 'hydrators._legacyHydrateMethod',
        bundle // will be available as bundle.inputData actually
      }) +
      '|||hydrate'
    );
  },

  dehydrateFile: (url, requestOptions, meta) => {
    url = url || undefined;
    requestOptions = requestOptions || undefined;
    meta = meta || undefined;

    if (!url && !request) {
      throw new exceptions.DehydrateException(
        'You must provide either url or request arguments!'
      );
    }

    if (url && typeof url !== 'string') {
      throw new exceptions.DehydrateException(
        'The provided url is not a string!'
      );
    }

    return (
      'hydrate|||' +
      JSON.stringify({
        type: 'method',
        method: 'hydrators._legacyHydrateFile',

        // will be available as bundle.inputData actually
        bundle: {
          url,
          request: requestOptions,
          meta
        }
      }) +
      '|||hydrate'
    );
  }
};

module.exports = z;

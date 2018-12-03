const { AUTH_JSON_SERVER_URL } = require('../auth-json-server');

const testAuthSource = `
  const responsePromise = z.request({
    url: '${AUTH_JSON_SERVER_URL}/me'
  });
  return responsePromise.then(response => {
    if (response.status !== 200) {
      throw new Error('Auth failed');
    }
    return z.JSON.parse(response.content);
  });
`;

// const maybeIncludeAuthSource = `
//   if (bundle.authData.api_key) {
//     request.headers['X-API-Key'] = bundle.authData.api_key;
//   }
//   return request;
// `;

const beforeRequestSource = `
  return z.legacyScripting.beforeRequest(request, z, bundle);
`;

module.exports = {
  legacy: {
    authentication: {
      mapping: { 'X-Api-Key': '{{api_key}}' },
      placement: 'header'
    }
  },

  authentication: {
    type: 'custom',
    test: { source: testAuthSource },
    fields: [
      {
        key: 'api_key',
        label: 'API Key',
        type: 'string',
        required: true
      }
    ]
  },
  beforeRequest: [
    {
      source: beforeRequestSource,
      args: ['request', 'z', 'bundle']
    }
  ]
  // beforeRequest: [
  //   { source: maybeIncludeAuthSource, args: ['request', 'z', 'bundle'] }
  // ]
};

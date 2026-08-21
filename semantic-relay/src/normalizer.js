const { v4: uuidv4 } = require('uuid');

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readHeader(req, name) {
  if (typeof req.get === 'function') return req.get(name);
  if (typeof req.header === 'function') return req.header(name);
  const headers = req.headers || {};
  return headers[name.toLowerCase()] || headers[name];
}

function normalizer(req) {
  const resource = req.path || (req.url ? req.url.split('?')[0] : '');
  const query = req.query || {};
  const page = parsePositiveInt(query.page, 1);
  const limit = parsePositiveInt(query.limit, 20);
  const groupKey = readHeader(req, 'x-relay-group')
    || readHeader(req, 'x-semantic-relay-group')
    || query.relayGroup
    || query.semanticRelayGroup
    || null;
  const expectedGroupSize = parsePositiveInt(
    readHeader(req, 'x-relay-expected-size')
      || readHeader(req, 'x-semantic-relay-expected-size')
      || query.relayExpectedSize
      || query.semanticRelayExpectedSize,
    0
  );

  const filters = {};
  for (const key in query) {
    if (
      key !== 'page'
      && key !== 'limit'
      && key !== 'relayGroup'
      && key !== 'semanticRelayGroup'
      && key !== 'relayExpectedSize'
      && key !== 'semanticRelayExpectedSize'
    ) {
      filters[key] = query[key];
    }
  }

  return {
    resource,
    page,
    limit,
    filters,
    groupKey: groupKey === null || groupKey === undefined ? null : String(groupKey),
    expectedGroupSize,
    intentId: uuidv4()
  };
}

module.exports = normalizer;
